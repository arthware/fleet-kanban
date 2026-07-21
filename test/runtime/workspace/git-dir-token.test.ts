import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeGitDirToken } from "../../../src/workspace/git-dir-token";

describe("computeGitDirToken", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "gitdir-token-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("given a path with no .git, when computing the token, then it returns null", async () => {
		expect(await computeGitDirToken(dir)).toBeNull();
	});

	it("given an unchanged .git directory, when computing twice, then the token is stable", async () => {
		const gitDir = join(dir, ".git");
		await mkdir(gitDir, { recursive: true });
		await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/main\n");

		expect(await computeGitDirToken(dir)).toBe(await computeGitDirToken(dir));
	});

	it("given a .git metadata file whose mtime moves, when re-computing, then the token changes", async () => {
		const gitDir = join(dir, ".git");
		await mkdir(gitDir, { recursive: true });
		const head = join(gitDir, "HEAD");
		await writeFile(head, "ref: refs/heads/main\n");
		await utimes(head, new Date(1_000_000), new Date(1_000_000));
		const first = await computeGitDirToken(dir);
		expect(first).not.toBeNull();

		await utimes(head, new Date(2_000_000), new Date(2_000_000));
		expect(await computeGitDirToken(dir)).not.toBe(first);
	});

	it("given a linked worktree whose .git is a gitdir pointer file, when computing, then it resolves the pointed-at dir", async () => {
		const realGitDir = join(dir, "main", ".git", "worktrees", "wt");
		await mkdir(realGitDir, { recursive: true });
		await writeFile(join(realGitDir, "HEAD"), "ref: refs/heads/feature\n");

		const worktree = join(dir, "wt");
		await mkdir(worktree, { recursive: true });
		await writeFile(join(worktree, ".git"), `gitdir: ${realGitDir}\n`);

		const token = await computeGitDirToken(worktree);
		expect(token).not.toBeNull();
		expect(token).toContain("HEAD:");
	});
});
