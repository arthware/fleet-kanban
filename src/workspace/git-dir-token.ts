import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

// The .git metadata files whose mtimes move when git itself mutates a repo:
// HEAD (checkout / branch switch), index (add / commit / status stat-refresh),
// logs/HEAD (every commit, reset, checkout — the reflog), ORIG_HEAD (reset / merge).
// Unstaged working-tree edits do NOT touch any of these — that gap is covered by
// polling active worktrees at full fidelity, not by this token.
const GIT_TOKEN_FILES = ["HEAD", "index", "logs/HEAD", "ORIG_HEAD"] as const;

/**
 * Resolve the real git directory for `worktreePath`. For a normal checkout that is
 * `<path>/.git` (a directory). For a linked worktree `.git` is a *file* containing
 * `gitdir: <path>`, pointing at `…/.git/worktrees/<name>` — where that worktree's own
 * HEAD/index/logs live. Returns `null` when there is no resolvable git dir.
 */
export async function resolveGitDir(worktreePath: string): Promise<string | null> {
	const dotGit = join(worktreePath, ".git");
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(dotGit);
	} catch {
		return null;
	}
	if (info.isDirectory()) {
		return dotGit;
	}
	try {
		const contents = await readFile(dotGit, "utf8");
		const match = contents.match(/^gitdir:\s*(.+)\s*$/m);
		if (!match) {
			return null;
		}
		const target = match[1].trim();
		return isAbsolute(target) ? target : resolve(worktreePath, target);
	} catch {
		return null;
	}
}

/**
 * Cheap change-detection token for a worktree, built from the mtimes of a few `.git`
 * metadata files — a handful of `stat` calls, no subprocess. When the token is
 * unchanged since the last poll, git has not committed/checked-out/branch-moved, so
 * the expensive `git status` scan can be skipped. Best-effort: never throws, and
 * returns `null` when the git dir cannot be resolved (caller then falls back to a
 * full probe rather than trusting a bogus "unchanged").
 */
export async function computeGitDirToken(worktreePath: string): Promise<string | null> {
	const gitDir = await resolveGitDir(worktreePath);
	if (!gitDir) {
		return null;
	}
	const parts = await Promise.all(
		GIT_TOKEN_FILES.map(async (relativePath) => {
			try {
				const info = await stat(join(gitDir, relativePath));
				return `${relativePath}:${info.mtimeMs}`;
			} catch {
				// Missing file (e.g. no reflog yet) is itself a stable signal.
				return `${relativePath}:-`;
			}
		}),
	);
	return parts.join("|");
}
