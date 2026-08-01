import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type {
	RuntimeBoardColumnId,
	RuntimeProjectsResponse,
	RuntimeWorktreeEnsureResponse,
} from "../../../src/core/api-contract";
import { seedIsolatedBoardState } from "../../utilities/board-seed";
import { createGitTestEnv } from "../../utilities/git-env";
import { type IsolatedKanbanInstance, startIsolatedKanbanInstance } from "../../utilities/kanban-test-instance";
import { createTempDir } from "../../utilities/temp-dir";
import { requestJson } from "../../utilities/trpc-request";
import { assertOk, createSelfcheckCard, ScenarioAssertionError } from "../scenario-api";

const DEFAULT_COLUMNS: Array<{ id: RuntimeBoardColumnId; title: string }> = [
	{ id: "backlog", title: "Backlog" },
	{ id: "in_progress", title: "In Progress" },
	{ id: "review", title: "Review" },
	{ id: "done", title: "Done" },
	{ id: "trash", title: "Trash" },
];

export async function givenWorktreeShapesWhenEnsuredThenTheyKeepTheExpectedArtifacts(): Promise<void> {
	const sandbox = createTempDir("kanban-selfcheck-worktree-shapes-");
	let instance: IsolatedKanbanInstance | null = null;
	try {
		const { repoPath, depPath } = createWorktreeShapeRepos(sandbox.path);
		instance = await startIsolatedKanbanInstance({
			cwd: repoPath,
			env: { GIT_ALLOW_PROTOCOL: "file" },
		});
		const baseUrl = new URL(instance.baseUrl).origin;
		const workspaceId = await resolveCurrentWorkspaceId(baseUrl);
		const shape1Path = await ensureWorktree(baseUrl, workspaceId, instance.homeDir, "task-card", "main");
		assertShape(shape1Path);

		const fleetDir = join(sandbox.path, "fleet_project", ".fleet");
		mkdirSync(fleetDir, { recursive: true });
		writeFileSync(
			join(fleetDir, "config.json"),
			JSON.stringify({ kanban_port: instance.port, repos: ["main-repo"] }),
		);
		const epic = runFleetCli(["epic", "create", "cool-epic", "--repo", "main-repo", "--base", "main"], {
			FLEET_DIR: fleetDir,
			CLINE_HOME: instance.homeDir,
			HOME: instance.homeDir,
			USERPROFILE: instance.homeDir,
			GIT_ALLOW_PROTOCOL: "file",
		});
		assertOk(epic.status === 0, `fleet epic create failed: ${epic.stderr || epic.stdout}`);
		assertShape(join(instance.homeDir, "epics", "main-repo@cool-epic"));

		const projects = await requestJson<RuntimeProjectsResponse>({
			baseUrl,
			procedure: "projects.list",
			type: "query",
		});
		const epicWorkspaceId =
			projects.payload.projects.find((project) => project.epic?.name === "cool-epic")?.id ?? null;
		if (!epicWorkspaceId) {
			throw new ScenarioAssertionError("Epic workspace was not registered.");
		}
		const shape3Path = await ensureWorktree(
			baseUrl,
			epicWorkspaceId,
			instance.homeDir,
			"epic-task-card",
			"epic/cool-epic",
		);
		assertShape(shape3Path);

		// Test config shape 2: Omitting node_modules from unsharedPaths
		const configPath = join(repoPath, ".cline", "kanban", "config.json");
		writeFileSync(
			configPath,
			JSON.stringify(
				{
					worktree: {
						postCreateCommand: "echo 'hook-ran' > post-create-marker.txt",
						unsharedPaths: ["dist", ".turbo"],
					},
				},
				null,
				2,
			),
			"utf8",
		);
		const shapeOmittedPath = await ensureWorktree(
			baseUrl,
			workspaceId,
			instance.homeDir,
			"task-card-omitted",
			"main",
		);
		assertShapeOmitted(shapeOmittedPath);

		// Test config shape 3: Explicitly trying to share node_modules via sharedPaths
		writeFileSync(
			configPath,
			JSON.stringify(
				{
					worktree: {
						postCreateCommand: "echo 'hook-ran' > post-create-marker.txt",
						unsharedPaths: ["dist", ".turbo"],
						sharedPaths: ["node_modules"],
					},
				},
				null,
				2,
			),
			"utf8",
		);
		const shapeSharedPath = await ensureWorktree(baseUrl, workspaceId, instance.homeDir, "task-card-shared", "main");
		assertShapeExplicitlyShared(shapeSharedPath);

		void depPath;
	} finally {
		await instance?.stop();
		sandbox.cleanup();
	}
}

function assertShapeOmitted(worktreePath: string): void {
	assertOk(
		existsSync(join(worktreePath, ".env")) && lstatSync(join(worktreePath, ".env")).isSymbolicLink(),
		".env was not a symlink.",
	);
	assertOk(
		existsSync(join(worktreePath, ".env.local")) && lstatSync(join(worktreePath, ".env.local")).isSymbolicLink(),
		".env.local was not a symlink.",
	);
	assertOk(existsSync(join(worktreePath, "vendor", "submodule", "dep-file.txt")), "Submodule was not checked out.");
	for (const path of ["dist", ".turbo"]) {
		assertOk(!existsSync(join(worktreePath, path)), `${path} should not be present in worktree.`);
	}
	let isSymlink = false;
	try {
		isSymlink = lstatSync(join(worktreePath, "node_modules")).isSymbolicLink();
	} catch (err) {
		if (!err || typeof err !== "object" || !("code" in err) || err.code !== "ENOENT") {
			throw err;
		}
	}
	assertOk(isSymlink === false, "node_modules must not be a symlink when omitted from unsharedPaths.");
}

function assertShapeExplicitlyShared(worktreePath: string): void {
	assertOk(
		existsSync(join(worktreePath, ".env")) && lstatSync(join(worktreePath, ".env")).isSymbolicLink(),
		".env was not a symlink.",
	);
	assertOk(
		existsSync(join(worktreePath, ".env.local")) && lstatSync(join(worktreePath, ".env.local")).isSymbolicLink(),
		".env.local was not a symlink.",
	);
	assertOk(existsSync(join(worktreePath, "vendor", "submodule", "dep-file.txt")), "Submodule was not checked out.");
	for (const path of ["dist", ".turbo"]) {
		assertOk(!existsSync(join(worktreePath, path)), `${path} should not be present in worktree.`);
	}
	let isSymlink = false;
	try {
		isSymlink = lstatSync(join(worktreePath, "node_modules")).isSymbolicLink();
	} catch (err) {
		if (!err || typeof err !== "object" || !("code" in err) || err.code !== "ENOENT") {
			throw err;
		}
	}
	assertOk(isSymlink === false, "node_modules must not be a symlink even when explicitly listed in sharedPaths.");
}

export function createWorktreeShapeRepos(root: string): { repoPath: string; depPath: string } {
	const fleetProjectDir = join(root, "fleet_project");
	const depPath = join(root, "dependency-repo");
	const repoPath = join(fleetProjectDir, "main-repo");
	mkdirSync(depPath, { recursive: true });
	runGit(depPath, ["init", "-b", "main"]);
	writeFileSync(join(depPath, "dep-file.txt"), "submodule-content\n", "utf8");
	runGit(depPath, ["add", "dep-file.txt"]);
	runGit(depPath, ["commit", "-m", "init-dep"]);

	mkdirSync(repoPath, { recursive: true });
	runGit(repoPath, ["init", "-b", "main"]);
	runGit(repoPath, ["config", "protocol.file.allow", "always"]);
	writeFileSync(join(repoPath, "README.md"), "main-content\n", "utf8");
	writeFileSync(
		join(repoPath, ".gitignore"),
		[
			".env",
			".env.local",
			"/node_modules/",
			"/dist/",
			"/.turbo/",
			"apps/lab/.env.local",
			"apps/lab/.env.test-integration",
			"packages/skill-runner/src/generated/",
			"packages/viewer/src/tailwind.build.css",
			"",
		].join("\n"),
		"utf8",
	);
	writeFileSync(join(repoPath, ".env"), "ENV_VAR=value\n", "utf8");
	writeFileSync(join(repoPath, ".env.local"), "ENV_LOCAL=local-value\n", "utf8");
	mkdirSync(join(repoPath, "node_modules"), { recursive: true });
	writeFileSync(join(repoPath, "node_modules", "ignore.txt"), "ignored-node-module\n", "utf8");
	mkdirSync(join(repoPath, "dist"), { recursive: true });
	writeFileSync(join(repoPath, "dist", "built.js"), "compiled-js\n", "utf8");
	mkdirSync(join(repoPath, ".turbo"), { recursive: true });
	writeFileSync(join(repoPath, ".turbo", "cache.json"), '{"cached":true}\n', "utf8");
	mkdirSync(join(repoPath, "apps", "lab", "src"), { recursive: true });
	writeFileSync(join(repoPath, "apps", "lab", "package.json"), '{"name":"lab"}\n', "utf8");
	writeFileSync(join(repoPath, "apps", "lab", "src", "index.ts"), "export const lab = true;\n", "utf8");
	writeFileSync(join(repoPath, "apps", "lab", ".env.local"), "LAB_ENV_LOCAL=local\n", "utf8");
	writeFileSync(join(repoPath, "apps", "lab", ".env.test-integration"), "LAB_ENV_TEST_INTEGRATION=test\n", "utf8");
	mkdirSync(join(repoPath, "packages", "skill-runner", "src", "generated"), { recursive: true });
	mkdirSync(join(repoPath, "packages", "viewer", "src"), { recursive: true });
	writeFileSync(join(repoPath, "packages", "skill-runner", "package.json"), '{"name":"skill-runner"}\n', "utf8");
	writeFileSync(
		join(repoPath, "packages", "skill-runner", "src", "index.ts"),
		"export const runner = true;\n",
		"utf8",
	);
	writeFileSync(
		join(repoPath, "packages", "skill-runner", "src", "generated", "runner-assets.json"),
		'{"assets":[]}\n',
		"utf8",
	);
	writeFileSync(join(repoPath, "packages", "viewer", "src", "app.tsx"), "export const App = null;\n", "utf8");
	writeFileSync(join(repoPath, "packages", "viewer", "src", "tailwind.build.css"), ".a{color:red}\n", "utf8");
	mkdirSync(join(repoPath, ".cline", "kanban"), { recursive: true });
	writeFileSync(
		join(repoPath, ".cline", "kanban", "config.json"),
		JSON.stringify(
			{
				worktree: {
					postCreateCommand: "echo 'hook-ran' > post-create-marker.txt",
					unsharedPaths: ["node_modules", "dist", ".turbo"],
				},
			},
			null,
			2,
		),
		"utf8",
	);
	runGit(repoPath, [
		"add",
		"README.md",
		".gitignore",
		".cline/kanban/config.json",
		"apps/lab/package.json",
		"apps/lab/src/index.ts",
		"packages/skill-runner/package.json",
		"packages/skill-runner/src/index.ts",
		"packages/viewer/src/app.tsx",
	]);
	runGit(repoPath, ["commit", "-m", "init-main"]);
	runGit(repoPath, ["-c", "protocol.file.allow=always", "submodule", "add", depPath, "vendor/submodule"]);
	runGit(repoPath, ["commit", "-m", "add-submodule"]);
	return { repoPath, depPath };
}

async function ensureWorktree(
	baseUrl: string,
	workspaceId: string,
	homeDir: string,
	taskId: string,
	baseRef: string,
): Promise<string> {
	seedIsolatedBoardState({
		homeDir,
		workspaceId,
		board: {
			columns: DEFAULT_COLUMNS.map((column) => ({
				...column,
				cards:
					column.id === "backlog"
						? [createSelfcheckCard({ id: taskId, title: taskId, baseRef, agentId: "claude" })]
						: [],
			})),
			dependencies: [],
		},
	});
	const ensured = await requestJson<RuntimeWorktreeEnsureResponse>({
		baseUrl,
		procedure: "workspace.ensureWorktree",
		type: "mutation",
		workspaceId,
		payload: { taskId, baseRef },
	});
	assertOk(ensured.status === 200 && ensured.payload.ok, `Could not ensure worktree ${taskId}.`);
	return ensured.payload.path;
}

function assertShape(worktreePath: string): void {
	assertOk(
		existsSync(join(worktreePath, ".env")) && lstatSync(join(worktreePath, ".env")).isSymbolicLink(),
		".env was not a symlink.",
	);
	assertOk(
		existsSync(join(worktreePath, ".env.local")) && lstatSync(join(worktreePath, ".env.local")).isSymbolicLink(),
		".env.local was not a symlink.",
	);
	assertOk(
		existsSync(join(worktreePath, "apps", "lab", ".env.local")) &&
			lstatSync(join(worktreePath, "apps", "lab", ".env.local")).isSymbolicLink(),
		"apps/lab/.env.local was not a symlink.",
	);
	assertOk(
		existsSync(join(worktreePath, "apps", "lab", ".env.test-integration")) &&
			lstatSync(join(worktreePath, "apps", "lab", ".env.test-integration")).isSymbolicLink(),
		"apps/lab/.env.test-integration was not a symlink.",
	);
	assertOk(existsSync(join(worktreePath, "vendor", "submodule", "dep-file.txt")), "Submodule was not checked out.");
	for (const path of ["node_modules", "dist", ".turbo"]) {
		assertOk(!existsSync(join(worktreePath, path)), `${path} should not be present in worktree.`);
	}
	assertOk(
		!existsSync(join(worktreePath, "packages", "skill-runner", "src", "generated")),
		"packages/skill-runner/src/generated should not be present in worktree.",
	);
	assertOk(
		!existsSync(join(worktreePath, "packages", "viewer", "src", "tailwind.build.css")),
		"packages/viewer/src/tailwind.build.css should not be present in worktree.",
	);
	assertOk(
		readFileSync(join(worktreePath, "post-create-marker.txt"), "utf8").trim() === "hook-ran",
		"postCreateCommand did not run.",
	);
}

function runFleetCli(args: string[], env: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("python3", [resolve(process.cwd(), "fleet-cli/fleet.py"), ...args], {
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

async function resolveCurrentWorkspaceId(baseUrl: string): Promise<string> {
	const projects = await requestJson<RuntimeProjectsResponse>({
		baseUrl,
		procedure: "projects.list",
		type: "query",
	});
	assertOk(projects.status === 200, "Could not list projects.");
	if (!projects.payload.currentProjectId) {
		throw new ScenarioAssertionError("Expected isolated instance to have a current project.");
	}
	return projects.payload.currentProjectId;
}
