import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGitProcessEnv } from "../../../src/core/git-process-env";
import {
	getWorkspaceChanges,
	getWorkspaceChangesFromRef,
	resolveTaskForkPoint,
} from "../../../src/workspace/get-workspace-changes";

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

function commitAll(cwd: string, message: string): string {
	git(cwd, ["add", "."]);
	git(cwd, ["commit", "-m", message]);
	return git(cwd, ["rev-parse", "HEAD"]);
}

function paths(files: { path: string }[]): string[] {
	return files.map((file) => file.path).sort((left, right) => left.localeCompare(right));
}

describe("workspace changes from a task fork point", () => {
	let repo: string;
	let worktree: string;

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "kanban-changes-repo-"));
		git(repo, ["init", "-b", "main"]);
		writeFileSync(join(repo, "README.md"), "base\n");
		writeFileSync(join(repo, "uncommitted.txt"), "base\n");
		commitAll(repo, "base");

		worktree = mkdtempSync(join(tmpdir(), "kanban-changes-wt-"));
		git(repo, ["worktree", "add", "--detach", worktree, "main"]);
	});

	afterEach(() => {
		rmSync(worktree, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	});

	it("resolves the task fork point as the merge-base of the base ref and HEAD", async () => {
		const baseCommit = git(worktree, ["rev-parse", "HEAD"]);
		writeFileSync(join(repo, "main-only.txt"), "base moved\n");
		commitAll(repo, "advance main");

		await expect(resolveTaskForkPoint(worktree, "main")).resolves.toBe(baseCommit);
	});

	it("returns null when the base ref cannot be resolved", async () => {
		await expect(resolveTaskForkPoint(worktree, "missing-ref")).resolves.toBeNull();
	});

	it("returns null for an unborn repository", async () => {
		const unbornRepo = mkdtempSync(join(tmpdir(), "kanban-unborn-repo-"));
		try {
			git(unbornRepo, ["init", "-b", "main"]);
			await expect(resolveTaskForkPoint(unbornRepo, "main")).resolves.toBeNull();
		} finally {
			rmSync(unbornRepo, { recursive: true, force: true });
		}
	});

	it("includes committed, uncommitted, and untracked files from the fork point", async () => {
		const forkPoint = await resolveTaskForkPoint(worktree, "main");
		expect(forkPoint).not.toBeNull();

		writeFileSync(join(worktree, "committed.txt"), "committed\n");
		commitAll(worktree, "task commit");
		writeFileSync(join(worktree, "uncommitted.txt"), "base\nchanged\n");
		writeFileSync(join(worktree, "untracked.txt"), "untracked\n");

		const changes = await getWorkspaceChangesFromRef({ cwd: worktree, fromRef: forkPoint ?? "" });

		expect(paths(changes.files)).toEqual(["committed.txt", "uncommitted.txt", "untracked.txt"]);
		expect(changes.files.find((file) => file.path === "committed.txt")?.status).toBe("added");
		expect(changes.files.find((file) => file.path === "uncommitted.txt")?.status).toBe("modified");
		expect(changes.files.find((file) => file.path === "untracked.txt")?.status).toBe("untracked");
	});

	it("combines changes across multiple task commits", async () => {
		const forkPoint = await resolveTaskForkPoint(worktree, "main");
		expect(forkPoint).not.toBeNull();

		writeFileSync(join(worktree, "first.txt"), "first\n");
		commitAll(worktree, "first task commit");
		writeFileSync(join(worktree, "second.txt"), "second\n");
		commitAll(worktree, "second task commit");

		const changes = await getWorkspaceChangesFromRef({ cwd: worktree, fromRef: forkPoint ?? "" });

		expect(paths(changes.files)).toEqual(["first.txt", "second.txt"]);
	});

	it("falls back to HEAD-only working changes when no fork point is available", async () => {
		writeFileSync(join(worktree, "uncommitted.txt"), "base\nchanged\n");

		const changes = await getWorkspaceChanges(worktree);

		expect(paths(changes.files)).toEqual(["uncommitted.txt"]);
		expect(changes.files[0]?.status).toBe("modified");
	});
});
