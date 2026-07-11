import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGitProcessEnv } from "../../../src/core/git-process-env";
import { assessTaskWorkDurability } from "../../../src/workspace/durable-save";

// Real-git assessment: validates the git-backed facts the pure classifier
// decides on — crucially that `git cherry` recognises a cherry-picked/merged
// commit by patch id (different sha, same content) as "landed".
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

describe("assessTaskWorkDurability (real git)", () => {
	let repo: string;
	let worktree: string;

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "durable-repo-"));
		git(repo, ["init", "-b", "main"]);
		writeFileSync(join(repo, "README.md"), "base\n");
		git(repo, ["add", "."]);
		git(repo, ["commit", "-m", "base"]);
		// Detached worktree off main, mirroring how the board creates task worktrees.
		worktree = join(repo, "wt");
		git(repo, ["worktree", "add", "--detach", worktree, "main"]);
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("is durable when the worktree exactly matches the base branch", async () => {
		const result = await assessTaskWorkDurability({
			worktreePath: worktree,
			worktreeExists: true,
			baseRef: "main",
			mode: "commit",
		});

		expect(result.durable).toBe(true);
		expect(result.status).toBe("clean_and_landed");
	});

	it("is NOT durable with uncommitted changes", async () => {
		writeFileSync(join(worktree, "feature.txt"), "wip\n");

		const result = await assessTaskWorkDurability({
			worktreePath: worktree,
			worktreeExists: true,
			baseRef: "main",
			mode: "commit",
		});

		expect(result.durable).toBe(false);
		expect(result.status).toBe("uncommitted_changes");
	});

	it("is NOT durable with an untracked (non-ignored) file", async () => {
		writeFileSync(join(worktree, "new-file.txt"), "brand new\n");

		const result = await assessTaskWorkDurability({
			worktreePath: worktree,
			worktreeExists: true,
			baseRef: "main",
			mode: "commit",
		});

		expect(result.durable).toBe(false);
		expect(result.status).toBe("uncommitted_changes");
	});

	it("is NOT durable when a commit exists in the worktree but has not landed on main", async () => {
		writeFileSync(join(worktree, "feature.txt"), "done\n");
		git(worktree, ["add", "."]);
		git(worktree, ["commit", "-m", "feature"]);

		const result = await assessTaskWorkDurability({
			worktreePath: worktree,
			worktreeExists: true,
			baseRef: "main",
			mode: "commit",
		});

		expect(result.durable).toBe(false);
		expect(result.status).toBe("unlanded_commits");
	});

	it("becomes durable once the commit is cherry-picked onto main (different sha, same patch)", async () => {
		writeFileSync(join(worktree, "feature.txt"), "done\n");
		git(worktree, ["add", "."]);
		git(worktree, ["commit", "-m", "feature"]);
		const taskCommit = git(worktree, ["rev-parse", "HEAD"]);

		// Land the work on main, exactly as the commit-mode auto-review prompt does.
		git(repo, ["cherry-pick", taskCommit]);

		const result = await assessTaskWorkDurability({
			worktreePath: worktree,
			worktreeExists: true,
			baseRef: "main",
			mode: "commit",
		});

		expect(result.durable).toBe(true);
		expect(result.status).toBe("clean_and_landed");
	});

	it("reports awaiting_merge in pr mode while the branch is unmerged", async () => {
		writeFileSync(join(worktree, "feature.txt"), "done\n");
		git(worktree, ["add", "."]);
		git(worktree, ["commit", "-m", "feature"]);

		const result = await assessTaskWorkDurability({
			worktreePath: worktree,
			worktreeExists: true,
			baseRef: "main",
			mode: "pr",
		});

		expect(result.durable).toBe(false);
		expect(result.status).toBe("awaiting_merge");
	});

	it("fails safe (indeterminate) when the base ref does not exist", async () => {
		const result = await assessTaskWorkDurability({
			worktreePath: worktree,
			worktreeExists: true,
			baseRef: "does-not-exist",
			mode: "commit",
		});

		expect(result.durable).toBe(false);
		expect(result.status).toBe("indeterminate");
	});
});
