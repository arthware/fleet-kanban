import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedIsolatedBoardState } from "../utilities/board-seed";
import { createGitTestEnv } from "../utilities/git-env";
import { startIsolatedKanbanInstance } from "../utilities/kanban-test-instance";
import { createTempDir } from "../utilities/temp-dir";
import { requestJson } from "../utilities/trpc-request";

interface RuntimeProjectsResponse {
	projects: Array<{
		id: string;
		path: string;
		epic?: {
			name: string;
			branch: string;
			base: string;
		};
	}>;
	currentProjectId: string | null;
}

interface RuntimeWorktreeEnsureResponse {
	ok: boolean;
	path: string;
	baseRef: string;
	baseCommit: string;
}

function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...createGitTestEnv(),
			...env,
		},
	});
	if (result.status !== 0) {
		throw new Error(
			[`git ${args.join(" ")} failed in ${cwd}`, result.stdout.trim(), result.stderr.trim()]
				.filter((part) => part.length > 0)
				.join("\n"),
		);
	}
	return result.stdout.trim();
}

function runFleetCli(args: string[], env: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("python3", [resolve(process.cwd(), "fleet-cli/fleet.py"), ...args], {
		env: {
			...process.env,
			...env,
		},
		encoding: "utf8",
	});
	return {
		status: result.status ?? 0,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function assertSymlink(filePath: string): void {
	expect(existsSync(filePath)).toBe(true);
	expect(lstatSync(filePath).isSymbolicLink()).toBe(true);
}

function assertSubmoduleCheckedOut(submodulePath: string): void {
	expect(existsSync(submodulePath)).toBe(true);
	const filePath = join(submodulePath, "dep-file.txt");
	expect(existsSync(filePath)).toBe(true);
	expect(readFileSync(filePath, "utf8").trim()).toBe("submodule-content");
}

function assertUnsharedPathsAbsent(worktreePath: string, unsharedPaths: string[]): void {
	for (const path of unsharedPaths) {
		const fullPath = join(worktreePath, path);
		expect(existsSync(fullPath)).toBe(false);
	}
}

/**
 * Generated artifacts that live inside a tracked source tree must never be mirrored:
 * an escaping symlink there is walked by bundlers/tsc as an in-root module (#171).
 */
function assertGeneratedSourceArtifactsAbsent(worktreePath: string): void {
	assertUnsharedPathsAbsent(worktreePath, [
		join("packages", "skill-runner", "src", "generated"),
		join("packages", "viewer", "src", "tailwind.build.css"),
	]);
}

function assertPostCreateCommandRan(worktreePath: string): void {
	const markerPath = join(worktreePath, "post-create-marker.txt");
	expect(existsSync(markerPath)).toBe(true);
	expect(readFileSync(markerPath, "utf8").trim()).toBe("hook-ran");
}

describe.sequential("worktree shapes integration suite", () => {
	let instance: any;
	let runtimeBaseUrl: string;
	let sandbox: { path: string; cleanup: () => void };
	let repoPath: string;
	let depPath: string;
	let workspaceId: string;
	let shape1Path: string;

	beforeAll(async () => {
		// 1. Setup temporary sandbox directory structure
		sandbox = createTempDir("kanban-worktree-shapes-sandbox-");
		const fleetProjDir = join(sandbox.path, "fleet_project");
		mkdirSync(fleetProjDir, { recursive: true });

		depPath = join(sandbox.path, "dependency-repo");
		repoPath = join(fleetProjDir, "main-repo");

		// 2. Initialize and commit dependency-repo (submodule remote)
		mkdirSync(depPath, { recursive: true });
		runGit(depPath, ["init", "-b", "main"]);
		runGit(depPath, ["config", "user.name", "Kanban Test"]);
		runGit(depPath, ["config", "user.email", "kanban-test@example.com"]);
		writeFileSync(join(depPath, "dep-file.txt"), "submodule-content\n", "utf8");
		runGit(depPath, ["add", "dep-file.txt"]);
		runGit(depPath, ["commit", "-m", "init-dep"]);

		// 3. Initialize main-repo
		mkdirSync(repoPath, { recursive: true });
		runGit(repoPath, ["init", "-b", "main"]);
		runGit(repoPath, ["config", "user.name", "Kanban Test"]);
		runGit(repoPath, ["config", "user.email", "kanban-test@example.com"]);
		runGit(repoPath, ["config", "protocol.file.allow", "always"]); // Local submodule allowed

		// 4. Create base files & unshared artifacts
		writeFileSync(join(repoPath, "README.md"), "main-content\n", "utf8");
		writeFileSync(
			join(repoPath, ".gitignore"),
			[
				".env",
				".env.local",
				"/node_modules/",
				"/dist/",
				"/.turbo/",
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
		writeFileSync(join(repoPath, ".turbo", "cache.json"), '{"cached": true}\n', "utf8");

		// Generated artifacts nested inside tracked source trees — the #171 shape. No name in the
		// unshared list matches them; only the structural rule keeps them out of the worktree.
		mkdirSync(join(repoPath, "packages", "skill-runner", "src", "generated"), { recursive: true });
		mkdirSync(join(repoPath, "packages", "viewer", "src"), { recursive: true });
		writeFileSync(join(repoPath, "packages", "skill-runner", "package.json"), '{"name":"skill-runner"}\n', "utf8");
		writeFileSync(join(repoPath, "packages", "skill-runner", "src", "index.ts"), "export const x = 1;\n", "utf8");
		writeFileSync(
			join(repoPath, "packages", "skill-runner", "src", "generated", "runner-assets.json"),
			'{"assets":[]}\n',
			"utf8",
		);
		writeFileSync(join(repoPath, "packages", "viewer", "src", "app.tsx"), "export const App = null;\n", "utf8");
		writeFileSync(join(repoPath, "packages", "viewer", "src", "tailwind.build.css"), ".a{color:red}\n", "utf8");

		// 5. Write .cline/kanban/config.json with custom unshared list + postCreateCommand
		mkdirSync(join(repoPath, ".cline", "kanban"), { recursive: true });
		const configData = {
			worktree: {
				postCreateCommand: "echo 'hook-ran' > post-create-marker.txt",
				unsharedPaths: ["node_modules", "dist", ".turbo"],
			},
		};
		writeFileSync(join(repoPath, ".cline", "kanban", "config.json"), JSON.stringify(configData, null, 2), "utf8");

		// Commit base files
		runGit(repoPath, [
			"add",
			"README.md",
			".gitignore",
			".cline/kanban/config.json",
			"packages/skill-runner/package.json",
			"packages/skill-runner/src/index.ts",
			"packages/viewer/src/app.tsx",
		]);
		runGit(repoPath, ["commit", "-m", "init-main"]);

		// Add dependency-repo as a submodule
		runGit(repoPath, ["-c", "protocol.file.allow=always", "submodule", "add", depPath, "vendor/submodule"]);
		runGit(repoPath, ["commit", "-m", "add-submodule"]);

		// 6. Boot isolated Kanban board pointed at main-repo CWD
		instance = await startIsolatedKanbanInstance({
			cwd: repoPath,
			env: {
				GIT_ALLOW_PROTOCOL: "file",
			},
		});
		runtimeBaseUrl = new URL(instance.baseUrl).origin;

		// 7. Extract registered workspaceId
		const projectsRes = await requestJson<RuntimeProjectsResponse>({
			baseUrl: runtimeBaseUrl,
			procedure: "projects.list",
			type: "query",
		});
		expect(projectsRes.status).toBe(200);
		expect(projectsRes.payload.currentProjectId).not.toBeNull();
		workspaceId = projectsRes.payload.currentProjectId as string;
	}, 45_000);

	afterAll(async () => {
		if (instance) {
			await instance.stop();
		}
		if (sandbox) {
			sandbox.cleanup();
		}
	}, 15_000);

	it("Shape 1: ensures a card worktree in an ordinary workspace correctly satisfies the contract", async () => {
		// Seed card on the board
		seedIsolatedBoardState({
			homeDir: instance.homeDir,
			workspaceId,
			board: {
				columns: [
					{
						id: "backlog",
						title: "Backlog",
						cards: [
							{
								id: "task-card",
								title: "Task Card",
								prompt: "Ensure card worktree contract",
								startInPlanMode: false,
								autoReviewEnabled: false,
								autoReviewMode: "pr",
								agentId: "droid",
								baseRef: "main",
								createdAt: Date.now(),
								updatedAt: Date.now(),
								transitions: [{ column: "backlog", at: Date.now() }],
							},
						],
					},
					{ id: "in_progress", title: "In Progress", cards: [] },
					{ id: "review", title: "Review", cards: [] },
					{ id: "done", title: "Done", cards: [] },
					{ id: "trash", title: "Trash", cards: [] },
				],
				dependencies: [],
			},
		});

		// Ensure worktree via tRPC mutation
		const ensured = await requestJson<RuntimeWorktreeEnsureResponse>({
			baseUrl: runtimeBaseUrl,
			procedure: "workspace.ensureWorktree",
			type: "mutation",
			workspaceId,
			payload: {
				taskId: "task-card",
				baseRef: "main",
			},
		});

		expect(ensured.status).toBe(200);
		expect(ensured.payload.ok).toBe(true);

		shape1Path = ensured.payload.path;
		expect(shape1Path).toContain("task-card");

		// Assert contract
		assertSymlink(join(shape1Path, ".env"));
		assertSymlink(join(shape1Path, ".env.local"));
		assertSubmoduleCheckedOut(join(shape1Path, "vendor", "submodule"));
		assertUnsharedPathsAbsent(shape1Path, ["node_modules", "dist", ".turbo"]);
		assertGeneratedSourceArtifactsAbsent(shape1Path);
		assertPostCreateCommandRan(shape1Path);
	}, 35_000);

	it("Shape 2: ensures an epic worktree created via fleet epic CLI correctly satisfies the contract", async () => {
		// 1. Setup CLI environment & config inside our sandbox
		const fleetDir = join(sandbox.path, "fleet_project", ".fleet");
		mkdirSync(fleetDir, { recursive: true });

		const cliConfig = {
			kanban_port: instance.port,
			repos: ["main-repo"],
		};
		writeFileSync(join(fleetDir, "config.json"), JSON.stringify(cliConfig, null, 2), "utf8");

		// 2. Call fleet epic create via subprocess
		const cliEnv = {
			FLEET_DIR: fleetDir,
			CLINE_HOME: instance.homeDir,
			HOME: instance.homeDir,
			USERPROFILE: instance.homeDir,
			GIT_ALLOW_PROTOCOL: "file",
		};

		const runResult = runFleetCli(["epic", "create", "cool-epic", "--repo", "main-repo", "--base", "main"], cliEnv);
		expect(runResult.status).toBe(0);

		// 3. Resolve epic worktree path
		// Path format: cline_home / epics / main-repo@cool-epic
		const shape2Path = join(instance.homeDir, "epics", "main-repo@cool-epic");

		expect(existsSync(shape2Path)).toBe(true);

		// Assert contract
		assertSymlink(join(shape2Path, ".env"));
		assertSymlink(join(shape2Path, ".env.local"));
		assertSubmoduleCheckedOut(join(shape2Path, "vendor", "submodule"));
		assertUnsharedPathsAbsent(shape2Path, ["node_modules", "dist", ".turbo"]);
		assertGeneratedSourceArtifactsAbsent(shape2Path);
		assertPostCreateCommandRan(shape2Path);
	}, 40_000);

	it("Shape 3: ensures a card worktree created inside an epic workspace correctly satisfies the contract", async () => {
		// 1. Get the epic workspace ID from projects.list
		const projectsRes = await requestJson<RuntimeProjectsResponse>({
			baseUrl: runtimeBaseUrl,
			procedure: "projects.list",
			type: "query",
		});
		expect(projectsRes.status).toBe(200);

		const epicWs = projectsRes.payload.projects.find((p) => p.epic && p.epic.name === "cool-epic");
		expect(epicWs).toBeDefined();
		const epicWorkspaceId = epicWs!.id;

		// 2. Seed a card on the epic workspace board
		seedIsolatedBoardState({
			homeDir: instance.homeDir,
			workspaceId: epicWorkspaceId,
			board: {
				columns: [
					{
						id: "backlog",
						title: "Backlog",
						cards: [
							{
								id: "epic-task-card",
								title: "Epic Task Card",
								prompt: "Ensure card-in-epic worktree contract",
								startInPlanMode: false,
								autoReviewEnabled: false,
								autoReviewMode: "pr",
								agentId: "droid",
								baseRef: "epic/cool-epic",
								createdAt: Date.now(),
								updatedAt: Date.now(),
								transitions: [{ column: "backlog", at: Date.now() }],
							},
						],
					},
					{ id: "in_progress", title: "In Progress", cards: [] },
					{ id: "review", title: "Review", cards: [] },
					{ id: "done", title: "Done", cards: [] },
					{ id: "trash", title: "Trash", cards: [] },
				],
				dependencies: [],
			},
		});

		// 3. Ensure the card worktree inside the epic workspace via tRPC
		const ensured = await requestJson<RuntimeWorktreeEnsureResponse>({
			baseUrl: runtimeBaseUrl,
			procedure: "workspace.ensureWorktree",
			type: "mutation",
			workspaceId: epicWorkspaceId,
			payload: {
				taskId: "epic-task-card",
				baseRef: "epic/cool-epic",
			},
		});

		expect(ensured.status).toBe(200);
		expect(ensured.payload.ok).toBe(true);

		const shape3Path = ensured.payload.path;
		expect(shape3Path).toContain("epic-task-card");

		// Assert contract
		assertSymlink(join(shape3Path, ".env"));
		assertSymlink(join(shape3Path, ".env.local"));
		assertSubmoduleCheckedOut(join(shape3Path, "vendor", "submodule"));
		assertUnsharedPathsAbsent(shape3Path, ["node_modules", "dist", ".turbo"]);
		assertGeneratedSourceArtifactsAbsent(shape3Path);
		assertPostCreateCommandRan(shape3Path);
	}, 40_000);

	it("Re-entry: honors unsharedPaths plus additionalUnsharedPaths and symlinks customized shared paths on a second ensure pass", async () => {
		// 1. Update config inside main-repo to omit node_modules from unsharedPaths.
		//    `.turbo` moves to additionalUnsharedPaths, which extends the replacing list.
		const updatedConfig = {
			worktree: {
				postCreateCommand: "echo 'hook-ran' > post-create-marker.txt",
				unsharedPaths: ["dist"], // node_modules is omitted, so it becomes SHARED/symlinked
				additionalUnsharedPaths: [".turbo"],
			},
		};
		writeFileSync(join(repoPath, ".cline", "kanban", "config.json"), JSON.stringify(updatedConfig, null, 2), "utf8");

		// 2. Run ensure pass again
		const ensuredAgain = await requestJson<RuntimeWorktreeEnsureResponse>({
			baseUrl: runtimeBaseUrl,
			procedure: "workspace.ensureWorktree",
			type: "mutation",
			workspaceId,
			payload: {
				taskId: "task-card",
				baseRef: "main",
			},
		});

		expect(ensuredAgain.status).toBe(200);
		expect(ensuredAgain.payload.ok).toBe(true);

		// Assert updated contract
		assertSymlink(join(shape1Path, ".env"));
		assertSymlink(join(shape1Path, ".env.local"));
		assertSubmoduleCheckedOut(join(shape1Path, "vendor", "submodule"));

		// node_modules MUST now be a symlink!
		assertSymlink(join(shape1Path, "node_modules"));

		// dist and .turbo MUST still be absent!
		assertUnsharedPathsAbsent(shape1Path, ["dist", ".turbo"]);
		// The structural rule is independent of config: generated sources stay local.
		assertGeneratedSourceArtifactsAbsent(shape1Path);
		assertPostCreateCommandRan(shape1Path);
	}, 35_000);
});
