import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGitProcessEnv } from "../../../src/core/git-process-env";
import { resolveTaskWorktreeContext } from "../../../src/workspace/task-worktree-context";

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, env: createGitProcessEnv(), stdio: "ignore" });
}

describe("resolveTaskWorktreeContext", () => {
	let tempRoot: string;
	let worktreesRoot: string;
	let mainRepoPath: string;
	let previousClineHome: string | undefined;

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "kanban-task-worktree-context-"));
		previousClineHome = process.env.CLINE_HOME;
		process.env.CLINE_HOME = join(tempRoot, "home");
		worktreesRoot = join(tempRoot, "home", "worktrees");

		mainRepoPath = join(tempRoot, "fleet-kanban");
		await mkdir(mainRepoPath, { recursive: true });
		// Canonicalize: git resolves worktree gitdir pointers through symlinks (e.g.
		// macOS's /tmp -> /private/tmp), so the expected path must match that.
		mainRepoPath = await realpath(mainRepoPath);
		git(mainRepoPath, ["init", "-b", "main"]);
		git(mainRepoPath, ["commit", "--allow-empty", "-m", "root"]);
	});

	afterEach(async () => {
		if (previousClineHome === undefined) {
			delete process.env.CLINE_HOME;
		} else {
			process.env.CLINE_HOME = previousClineHome;
		}
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("given a cwd outside any git repo, when resolving, then it returns null", async () => {
		const bareDir = join(tempRoot, "not-a-repo");
		await mkdir(bareDir, { recursive: true });

		expect(await resolveTaskWorktreeContext(bareDir)).toBeNull();
	});

	it("given a cwd inside the main (non-worktree) repo, when resolving, then it returns null", async () => {
		expect(await resolveTaskWorktreeContext(mainRepoPath)).toBeNull();
	});

	it("given a cwd at the root of a task worktree, when resolving, then it returns the task id and main repo path", async () => {
		const taskId = "b7e6c";
		const worktreePath = join(worktreesRoot, taskId, "fleet-kanban");
		await mkdir(join(worktreesRoot, taskId), { recursive: true });
		git(mainRepoPath, ["worktree", "add", worktreePath, "-b", `${taskId}-branch`]);

		await expect(resolveTaskWorktreeContext(worktreePath)).resolves.toEqual({
			taskId,
			mainRepoPath,
		});
	});

	it("given a cwd in a subdirectory of a task worktree, when resolving, then it still resolves by walking up to the worktree root", async () => {
		const taskId = "b7e6c";
		const worktreePath = join(worktreesRoot, taskId, "fleet-kanban");
		await mkdir(join(worktreesRoot, taskId), { recursive: true });
		git(mainRepoPath, ["worktree", "add", worktreePath, "-b", `${taskId}-branch`]);
		const subDir = join(worktreePath, "web-ui");
		await mkdir(subDir, { recursive: true });

		await expect(resolveTaskWorktreeContext(subDir)).resolves.toEqual({
			taskId,
			mainRepoPath,
		});
	});

	it("given a git repo cloned directly under the worktrees root (not a linked worktree), when resolving, then it returns null", async () => {
		const taskId = "not-actually-linked";
		const standaloneRepoPath = join(worktreesRoot, taskId, "fleet-kanban");
		await mkdir(standaloneRepoPath, { recursive: true });
		git(standaloneRepoPath, ["init", "-b", "main"]);

		expect(await resolveTaskWorktreeContext(standaloneRepoPath)).toBeNull();
	});
});
