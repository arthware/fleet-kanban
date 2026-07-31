import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

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

export async function givenFreshWorktreeWhenCreatedThenTheCommitGateIsInstalled(): Promise<void> {
	const sandbox = createTempDir("kanban-selfcheck-commit-gate-");
	let instance: IsolatedKanbanInstance | null = null;
	try {
		const { repoPath } = createRepoWithCommitGate(sandbox.path);
		instance = await startIsolatedKanbanInstance({
			cwd: repoPath,
			env: { GIT_ALLOW_PROTOCOL: "file" },
		});
		const baseUrl = new URL(instance.baseUrl).origin;
		const workspaceId = await resolveCurrentWorkspaceId(baseUrl);

		// Create a task worktree through the runtime
		const worktreePath = await ensureWorktree(baseUrl, workspaceId, instance.homeDir, "task-card", "main");

		// Resolve the hooks directory using `git rev-parse --git-path hooks` from inside the worktree
		const resolvedHooksDir = runGit(worktreePath, ["rev-parse", "--git-path", "hooks"]);
		const absoluteHooksDir = isAbsolute(resolvedHooksDir)
			? resolvedHooksDir
			: resolve(worktreePath, resolvedHooksDir);

		assertOk(existsSync(absoluteHooksDir), `Resolved hooks directory ${absoluteHooksDir} does not exist.`);
		const preCommitPath = join(absoluteHooksDir, "pre-commit");
		assertOk(
			existsSync(preCommitPath),
			`pre-commit hook does not exist in resolved hooks directory ${preCommitPath}.`,
		);

		// Verify pre-commit file is executable (has +x)
		const stats = lstatSync(preCommitPath);
		const isExecutable = (stats.mode & 0o111) !== 0;
		assertOk(isExecutable, `pre-commit hook at ${preCommitPath} is not executable.`);
	} finally {
		await instance?.stop();
		sandbox.cleanup();
	}
}

function createRepoWithCommitGate(root: string): { repoPath: string } {
	const repoPath = join(root, "main-repo");
	mkdirSync(repoPath, { recursive: true });
	runGit(repoPath, ["init", "-b", "main"]);

	writeFileSync(join(repoPath, "README.md"), "main-content\n", "utf8");

	// Create .husky directory with pre-commit
	mkdirSync(join(repoPath, ".husky"), { recursive: true });
	writeFileSync(join(repoPath, ".husky", "pre-commit"), "#!/bin/sh\necho 'precommit-gate-running'\nexit 0\n", {
		encoding: "utf8",
		mode: 0o755, // executable
	});

	// Point core.hooksPath at .husky in git config
	runGit(repoPath, ["config", "core.hooksPath", ".husky"]);

	// Create config.json
	mkdirSync(join(repoPath, ".cline", "kanban"), { recursive: true });
	writeFileSync(
		join(repoPath, ".cline", "kanban", "config.json"),
		JSON.stringify(
			{
				worktree: {
					postCreateCommand: "echo 'post-create-ran' > post-create-marker.txt",
				},
			},
			null,
			2,
		),
		"utf8",
	);

	runGit(repoPath, ["add", "README.md", ".husky/pre-commit", ".cline/kanban/config.json"]);
	runGit(repoPath, ["commit", "-m", "init-main"]);

	return { repoPath };
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
