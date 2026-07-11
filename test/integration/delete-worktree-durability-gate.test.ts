import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGitProcessEnv } from "../../../src/core/git-process-env";
import { deleteTaskWorktree, ensureTaskWorktreeIfDoesntExist } from "../../../src/workspace/task-worktree";

// The by-construction backstop: whatever the caller does, a worktree holding
// un-saved work is not removed unless the caller explicitly Discards it. This
// is the single choke point both the CLI (`task done`) and the web-ui delete
// through, so gating it here makes silent data loss impossible.
function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		// createGitProcessEnv strips GIT_DIR/GIT_INDEX_FILE/etc so the outer
		// `git commit` (pre-commit hook) can't redirect these temp-repo commands.
		env: createGitProcessEnv({
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		}),
	}).trim();
}

const TASK_ID = "task-durable-1";

describe("deleteTaskWorktree durability gate", () => {
	let clineHome: string;
	let repo: string;
	let worktreePath: string;
	let previousClineHome: string | undefined;

	beforeEach(async () => {
		previousClineHome = process.env.CLINE_HOME;
		clineHome = mkdtempSync(join(tmpdir(), "durable-home-"));
		process.env.CLINE_HOME = clineHome;

		repo = mkdtempSync(join(tmpdir(), "durable-src-"));
		git(repo, ["init", "-b", "main"]);
		writeFileSync(join(repo, "README.md"), "base\n");
		git(repo, ["add", "."]);
		git(repo, ["commit", "-m", "base"]);

		const ensured = await ensureTaskWorktreeIfDoesntExist({ cwd: repo, taskId: TASK_ID, baseRef: "main" });
		expect(ensured.ok).toBe(true);
		if (!ensured.path) {
			throw new Error("Expected worktree path");
		}
		worktreePath = ensured.path;
	});

	afterEach(() => {
		if (previousClineHome === undefined) {
			delete process.env.CLINE_HOME;
		} else {
			process.env.CLINE_HOME = previousClineHome;
		}
		rmSync(clineHome, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	});

	it("removes a worktree whose work is durably saved", async () => {
		const result = await deleteTaskWorktree({ repoPath: repo, taskId: TASK_ID, baseRef: "main", mode: "commit" });

		expect(result.ok).toBe(true);
		expect(result.removed).toBe(true);
		expect(existsSync(worktreePath)).toBe(false);
	});

	it("REFUSES to remove a worktree with uncommitted work — and keeps it as the safety net", async () => {
		writeFileSync(join(worktreePath, "feature.txt"), "uncommitted work\n");

		const result = await deleteTaskWorktree({ repoPath: repo, taskId: TASK_ID, baseRef: "main", mode: "commit" });

		expect(result.ok).toBe(false);
		expect(result.blocked).toBe(true);
		expect(result.removed).toBe(false);
		expect(result.durability?.status).toBe("uncommitted_changes");
		// The worktree — the only copy of the work — must still be there.
		expect(existsSync(worktreePath)).toBe(true);
		expect(existsSync(join(worktreePath, "feature.txt"))).toBe(true);
	});

	it("removes un-saved work only when Discard is explicit", async () => {
		writeFileSync(join(worktreePath, "feature.txt"), "throwaway\n");

		const result = await deleteTaskWorktree({
			repoPath: repo,
			taskId: TASK_ID,
			baseRef: "main",
			mode: "commit",
			discard: true,
		});

		expect(result.ok).toBe(true);
		expect(result.removed).toBe(true);
		expect(existsSync(worktreePath)).toBe(false);
	});

	it("refuses to remove a committed-but-unlanded worktree (pr mode: awaiting merge)", async () => {
		writeFileSync(join(worktreePath, "feature.txt"), "done\n");
		git(worktreePath, ["add", "."]);
		git(worktreePath, ["commit", "-m", "feature"]);

		const result = await deleteTaskWorktree({ repoPath: repo, taskId: TASK_ID, baseRef: "main", mode: "pr" });

		expect(result.ok).toBe(false);
		expect(result.blocked).toBe(true);
		expect(result.durability?.status).toBe("awaiting_merge");
		expect(existsSync(worktreePath)).toBe(true);
	});
});
