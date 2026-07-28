import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGitProcessEnv } from "../../../src/core/git-process-env";
import { deleteArchivedTaskWorktrees, deleteTaskWorktree } from "../../../src/workspace/task-worktree";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: createGitProcessEnv({
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		}),
	}).trim();
}

function gitWorktreePaths(repoPath: string): string[] {
	return git(repoPath, ["worktree", "list", "--porcelain"])
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length));
}

describe("deleteArchivedTaskWorktrees", () => {
	let previousClineHome: string | undefined;
	let tempRoot: string;
	let repoPath: string;

	beforeEach(() => {
		previousClineHome = process.env.CLINE_HOME;
		tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "kanban-archived-worktrees-")));
		process.env.CLINE_HOME = join(tempRoot, "home");
		repoPath = join(tempRoot, "repo");
		git(tempRoot, ["init", "-b", "main", repoPath]);
		writeFileSync(join(repoPath, "README.md"), "base\n");
		git(repoPath, ["add", "."]);
		git(repoPath, ["commit", "-m", "base"]);
	});

	afterEach(() => {
		if (previousClineHome === undefined) {
			delete process.env.CLINE_HOME;
		} else {
			process.env.CLINE_HOME = previousClineHome;
		}
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("given an archived card with dirty work, when archive reconciliation runs, then it deletes the worktree, deregisters git, and reports discarded work", async () => {
		// Given
		const taskId = "archived-dirty";
		const worktreePath = join(process.env.CLINE_HOME ?? "", "worktrees", taskId, basename(repoPath));
		git(repoPath, ["worktree", "add", "--detach", worktreePath, "main"]);
		writeFileSync(join(worktreePath, "wip.txt"), "unsaved\n");

		// When
		const result = await deleteArchivedTaskWorktrees({
			repoPath,
			taskIds: [taskId],
			baseRefByTaskId: { [taskId]: "main" },
		});

		// Then
		expect(result.cleaned).toHaveLength(1);
		expect(result.cleaned[0]).toMatchObject({
			taskId,
			removed: true,
			discardedStatus: "uncommitted_changes",
		});
		expect(result.cleaned[0]?.discardedDetail).toContain("uncommitted");
		expect(existsSync(worktreePath)).toBe(false);
		expect(gitWorktreePaths(repoPath)).not.toContain(worktreePath);
	});

	it("given git has a stale archived-card worktree registration, when archive reconciliation runs, then git forgets it", async () => {
		// Given
		const taskId = "archived-stale";
		const worktreePath = join(process.env.CLINE_HOME ?? "", "worktrees", taskId, basename(repoPath));
		git(repoPath, ["worktree", "add", "--detach", worktreePath, "main"]);
		rmSync(worktreePath, { recursive: true, force: true });
		expect(gitWorktreePaths(repoPath)).toContain(worktreePath);

		// When
		const result = await deleteArchivedTaskWorktrees({
			repoPath,
			taskIds: [taskId],
			baseRefByTaskId: { [taskId]: "main" },
		});

		// Then
		expect(result.cleaned).toContainEqual({
			taskId,
			removed: false,
			staleRegistrationPruned: true,
		});
		expect(gitWorktreePaths(repoPath)).not.toContain(worktreePath);
	});

	it("given a done card with an open PR, when normal worktree cleanup is requested, then the worktree is retained", async () => {
		// Given
		const taskId = "done-open-pr";
		const worktreePath = join(process.env.CLINE_HOME ?? "", "worktrees", taskId, basename(repoPath));
		git(repoPath, ["worktree", "add", "--detach", worktreePath, "main"]);
		writeFileSync(join(worktreePath, "feature.txt"), "waiting for merge\n");
		git(worktreePath, ["add", "."]);
		git(worktreePath, ["commit", "-m", "feature"]);

		// When
		const result = await deleteTaskWorktree({
			repoPath,
			taskId,
			baseRef: "main",
			mode: "pr",
		});

		// Then
		expect(result).toMatchObject({
			ok: false,
			removed: false,
			blocked: true,
			durability: { status: "awaiting_merge" },
		});
		expect(existsSync(worktreePath)).toBe(true);
		expect(gitWorktreePaths(repoPath)).toContain(worktreePath);
	});
});
