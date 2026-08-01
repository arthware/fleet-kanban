import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createGitTestEnv } from "../../utilities/git-env";
import { type IsolatedKanbanInstance, startIsolatedKanbanInstance } from "../../utilities/kanban-test-instance";
import { createTempDir } from "../../utilities/temp-dir";
import { assertOk, ScenarioAssertionError } from "../scenario-api";
import { createWorktreeShapeRepos } from "./givenWorktreeShapesWhenEnsuredThenTheyKeepTheExpectedArtifacts";

export async function givenCompletedEpicWhenArchivedThenItsWorktreeIsRemoved(): Promise<void> {
	const sandbox = createTempDir("kanban-selfcheck-epic-lifecycle-");
	let instance: IsolatedKanbanInstance | null = null;
	try {
		const { repoPath } = createWorktreeShapeRepos(sandbox.path);

		// Start isolated board
		instance = await startIsolatedKanbanInstance({
			cwd: repoPath,
			env: { GIT_ALLOW_PROTOCOL: "file" },
		});
		const baseUrl = new URL(instance.baseUrl).origin;

		// Set up .fleet config
		const fleetDir = join(sandbox.path, "fleet_project", ".fleet");
		mkdirSync(fleetDir, { recursive: true });
		writeFileSync(
			join(fleetDir, "config.json"),
			JSON.stringify({ kanban_port: instance.port, repos: ["main-repo"] }),
		);

		// Helper to run fleet commands
		const env = {
			FLEET_DIR: fleetDir,
			CLINE_HOME: instance.homeDir,
			HOME: instance.homeDir,
			USERPROFILE: instance.homeDir,
			GIT_ALLOW_PROTOCOL: "file",
			KANBAN_URL: baseUrl,
		};

		// --- Scenario 1: Create cool-epic ---
		const epicCreate1 = runFleetCli(["epic", "create", "cool-epic", "--repo", "main-repo", "--base", "main"], env);
		assertOk(
			epicCreate1.status === 0,
			`fleet epic create cool-epic failed: ${epicCreate1.stderr || epicCreate1.stdout}`,
		);

		const epic1WtPath = join(instance.homeDir, "epics", "main-repo@cool-epic");
		assertOk(existsSync(epic1WtPath), "cool-epic worktree was not created.");

		// --- Scenario 2: Refusal path - uncommitted changes ---
		writeFileSync(join(epic1WtPath, "README.md"), "dirty changes\n");

		const epicCompleteDirty = runFleetCli(["epic", "complete", "cool-epic", "--repo", "main-repo"], env);
		assertOk(epicCompleteDirty.status !== 0, "epic complete should have failed with uncommitted changes");
		assertOk(
			epicCompleteDirty.stderr.includes("uncommitted changes") ||
				epicCompleteDirty.stdout.includes("uncommitted changes"),
			`Expected error about uncommitted changes, got:\n${epicCompleteDirty.stderr}\n${epicCompleteDirty.stdout}`,
		);

		// Clean up dirty changes
		runGit(epic1WtPath, ["checkout", "README.md"]);

		// --- Scenario 3: Refusal path - uncontained commits ---
		// Add an uncontained commit inside the worktree
		writeFileSync(join(epic1WtPath, "README.md"), "modified main content\n");
		runGit(epic1WtPath, ["add", "README.md"]);
		runGit(epic1WtPath, ["commit", "-m", "uncontained commits"]);

		const epicCompleteUncontained = runFleetCli(["epic", "complete", "cool-epic", "--repo", "main-repo"], env);
		assertOk(epicCompleteUncontained.status !== 0, "epic complete should have failed with uncontained commits");
		assertOk(
			epicCompleteUncontained.stderr.includes("not fully merged/contained") ||
				epicCompleteUncontained.stdout.includes("not fully merged/contained"),
			`Expected error about uncontained commits, got:\n${epicCompleteUncontained.stderr}\n${epicCompleteUncontained.stdout}`,
		);

		// --- Scenario 4: Use --force to complete anyway ---
		const epicCompleteForced = runFleetCli(["epic", "complete", "cool-epic", "--repo", "main-repo", "--force"], env);
		assertOk(
			epicCompleteForced.status === 0,
			`epic complete with --force failed: ${epicCompleteForced.stderr || epicCompleteForced.stdout}`,
		);
		assertOk(!existsSync(epic1WtPath), "epic worktree was not removed on forced complete.");

		// --- Scenario 5: Contained/Merged Path ---
		// Create another epic that will be merged
		const epicCreate2 = runFleetCli(["epic", "create", "merged-epic", "--repo", "main-repo", "--base", "main"], env);
		assertOk(
			epicCreate2.status === 0,
			`fleet epic create merged-epic failed: ${epicCreate2.stderr || epicCreate2.stdout}`,
		);

		const epic2WtPath = join(instance.homeDir, "epics", "main-repo@merged-epic");
		assertOk(existsSync(epic2WtPath), "merged-epic worktree was not created.");

		// Merge the epic branch 'epic/merged-epic' into 'main' to make it contained
		runGit(repoPath, ["checkout", "main"]);
		runGit(repoPath, ["merge", "epic/merged-epic"]);

		const epicCompleteMerged = runFleetCli(["epic", "complete", "merged-epic", "--repo", "main-repo"], env);
		assertOk(
			epicCompleteMerged.status === 0,
			`epic complete for merged epic failed: ${epicCompleteMerged.stderr || epicCompleteMerged.stdout}`,
		);
		assertOk(
			epicCompleteMerged.stdout.includes("already merged/contained"),
			`Expected already merged log, got:\n${epicCompleteMerged.stdout}`,
		);
		assertOk(!existsSync(epic2WtPath), "merged-epic worktree was not removed on merge complete.");

		// --- Scenario 6: Archived workspaces are hidden from listing ---
		const taskListDefault = runFleetCli(["task", "list"], env);
		assertOk(
			taskListDefault.status === 0,
			`fleet task list failed with status ${taskListDefault.status}.\nstdout: ${taskListDefault.stdout}\nstderr: ${taskListDefault.stderr}`,
		);
		assertOk(
			!taskListDefault.stdout.includes("cool-epic") && !taskListDefault.stdout.includes("merged-epic"),
			`Archived workspaces should be hidden from default listing. Output:\n${taskListDefault.stdout}`,
		);

		const taskListArchived = runFleetCli(["task", "list", "--archived"], env);
		assertOk(taskListArchived.status === 0, "fleet task list --archived failed");
		assertOk(
			taskListArchived.stdout.includes("cool-epic") || taskListArchived.stdout.includes("merged-epic"),
			`Archived workspaces should be shown with --archived. Output:\n${taskListArchived.stdout}`,
		);
	} finally {
		await instance?.stop();
		sandbox.cleanup();
	}
}

function runFleetCli(args: string[], env: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("bash", [resolve(process.cwd(), "fleet-cli/fleet"), ...args], {
		env: { ...process.env, ...env },
		encoding: "utf8",
	});
	return { status: result.status ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv({ GIT_ALLOW_PROTOCOL: "file" }),
	});
	if (result.status !== 0) {
		throw new ScenarioAssertionError(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.stdout}`);
	}
	return result.stdout.trim();
}
