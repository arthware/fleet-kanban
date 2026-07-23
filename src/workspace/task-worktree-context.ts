import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { getTaskWorktreesHomePath } from "../state/workspace-state";
import { resolveGitDir } from "./git-dir-token";

export interface TaskWorktreeContext {
	taskId: string;
	mainRepoPath: string;
}

async function findGitRootUpward(startDir: string): Promise<string | null> {
	let current = resolve(startDir);
	for (;;) {
		if (await resolveGitDir(current)) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) {
			return null;
		}
		current = parent;
	}
}

/**
 * Resolve `cwd` back to the Kanban task it belongs to, when `cwd` is inside one of
 * Kanban's own task worktrees (`<CLINE_HOME>/worktrees/<taskId>/<repoLabel>`, see
 * `getTaskWorktreePath` in `task-worktree.ts`). A linked worktree's `.git` file points at
 * `<mainRepo>/.git/worktrees/<name>`, so walking that pointer back up three segments
 * recovers the registered project path — the one thing a worktree path itself can't
 * express, since the workspace label is a lossy last-path-segment of it.
 *
 * Returns `null` for any cwd that isn't inside a Kanban-managed linked worktree (a normal
 * checkout, an unrelated repo, or a directory that merely happens to sit under the
 * worktrees root without being a real linked worktree).
 */
export async function resolveTaskWorktreeContext(cwd: string): Promise<TaskWorktreeContext | null> {
	const worktreeRoot = await findGitRootUpward(cwd);
	if (!worktreeRoot) {
		return null;
	}

	const worktreesRoot = resolve(getTaskWorktreesHomePath());
	const relativePath = relative(worktreesRoot, worktreeRoot);
	if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
		return null;
	}
	const taskId = relativePath.split(sep)[0];
	if (!taskId) {
		return null;
	}

	const gitDirTarget = await resolveGitDir(worktreeRoot);
	if (!gitDirTarget) {
		return null;
	}
	const worktreesDir = dirname(gitDirTarget);
	if (basename(worktreesDir) !== "worktrees") {
		// Not a linked-worktree gitdir shape (`<mainRepo>/.git/worktrees/<name>`) —
		// e.g. a standalone repo someone happened to `git init` under the worktrees root.
		return null;
	}
	const dotGitDir = dirname(worktreesDir);
	const mainRepoPath = dirname(dotGitDir);

	return { taskId, mainRepoPath };
}
