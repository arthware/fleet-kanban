import type { RuntimeWorktreeConfig } from "../core/api-contract";

const TSBUILDINFO_PATTERN = "*.tsbuildinfo";

export const DEFAULT_WORKTREE_UNSHARED_PATHS = [
	"node_modules",
	"dist",
	"build",
	"out",
	".next",
	".turbo",
	".cache",
	".vite",
	".parcel-cache",
	".svelte-kit",
	".nuxt",
	".output",
	TSBUILDINFO_PATTERN,
] as const;

function toPlatformRelativePath(path: string): string {
	return path
		.trim()
		.replaceAll("\\", "/")
		.replace(/\/+$/g, "")
		.split("/")
		.filter((segment) => segment.length > 0)
		.join("/");
}

function pathPatternMatchesBasename(pattern: string, basename: string): boolean {
	if (!pattern.startsWith("*.") || pattern.length <= 2) {
		return false;
	}
	return basename.endsWith(pattern.slice(1));
}

export function isWorktreeEnvFilePath(relativePath: string): boolean {
	const normalizedPath = toPlatformRelativePath(relativePath);
	const basename = normalizedPath.split("/").at(-1) ?? "";
	return basename === ".env" || basename.startsWith(".env.");
}

/**
 * Name rule: a repo-tunable list of artifact basenames (or `*.ext` globs) that never
 * get mirrored, matched against any segment of the path.
 */
export function shouldKeepPathUnsharedInWorktree(relativePath: string, unsharedPaths: readonly string[]): boolean {
	const pathSegments = toPlatformRelativePath(relativePath).split("/").filter(Boolean);
	if (pathSegments.length === 0) {
		return false;
	}

	const normalizedUnsharedPaths = unsharedPaths.map((path) => toPlatformRelativePath(path)).filter(Boolean);
	return normalizedUnsharedPaths.some((unsharedPath) =>
		pathSegments.some((segment) => segment === unsharedPath || pathPatternMatchesBasename(unsharedPath, segment)),
	);
}

/**
 * Every directory below the repo root that git tracks something inside — the repo's
 * checked-out source trees. The repo root itself is deliberately excluded: it is the
 * container for workspace-level local state (`.env`, tool config), not a source tree.
 */
export function collectTrackedDirectories(trackedFilePaths: readonly string[]): Set<string> {
	const trackedDirectories = new Set<string>();
	for (const trackedFilePath of trackedFilePaths) {
		const segments = toPlatformRelativePath(trackedFilePath).split("/").filter(Boolean);
		for (let depth = 1; depth < segments.length; depth += 1) {
			trackedDirectories.add(segments.slice(0, depth).join("/"));
		}
	}
	return trackedDirectories;
}

/**
 * Structural rule: is this ignored path nested inside a tracked source tree?
 *
 * A symlink that escapes the worktree is only safe while nothing walks it as an in-root
 * module. Anything sitting under a directory git tracks files in is on a bundler's or
 * tsc's traversal path, so mirroring it there is what produces
 * "Symlink … points out of the filesystem root".
 */
export function isPathInsideTrackedSourceTree(relativePath: string, trackedDirectories: ReadonlySet<string>): boolean {
	const segments = toPlatformRelativePath(relativePath).split("/").filter(Boolean);
	for (let depth = 1; depth < segments.length; depth += 1) {
		if (trackedDirectories.has(segments.slice(0, depth).join("/"))) {
			return true;
		}
	}
	return false;
}

function isPathCoveredBySharedPaths(relativePath: string, sharedPaths: readonly string[]): boolean {
	const normalizedPath = toPlatformRelativePath(relativePath);
	if (!normalizedPath) {
		return false;
	}
	return sharedPaths
		.map((sharedPath) => toPlatformRelativePath(sharedPath))
		.filter(Boolean)
		.some((sharedPath) => normalizedPath === sharedPath || normalizedPath.startsWith(`${sharedPath}/`));
}

export interface WorktreeMirrorRules {
	/** Artifact names that never get mirrored (see {@link resolveWorktreeUnsharedPaths}). */
	unsharedPaths: readonly string[];
	/** Directories git tracks files in (see {@link collectTrackedDirectories}). */
	trackedDirectories: ReadonlySet<string>;
	/** Repo-relative paths the repo explicitly wants mirrored regardless of the two rules above. */
	sharedPaths?: readonly string[];
}

/**
 * The single decision point for whether a git-ignored path is mirrored into a task worktree.
 *
 * The repo's explicit `sharedPaths` win; otherwise a path stays local when its name matches the
 * unshared list, or when it sits inside a tracked source tree.
 */
export function shouldMirrorIgnoredPathIntoWorktree(relativePath: string, rules: WorktreeMirrorRules): boolean {
	if (rules.sharedPaths && isPathCoveredBySharedPaths(relativePath, rules.sharedPaths)) {
		return true;
	}
	if (shouldKeepPathUnsharedInWorktree(relativePath, rules.unsharedPaths)) {
		return false;
	}
	if (isWorktreeEnvFilePath(relativePath)) {
		return true;
	}
	return !isPathInsideTrackedSourceTree(relativePath, rules.trackedDirectories);
}

/**
 * `unsharedPaths` replaces the built-in defaults (so a repo can share `node_modules` again);
 * `additionalUnsharedPaths` extends whichever list is in effect, so adding one artifact name
 * never silently drops the dependency and build-cache defaults.
 */
export function resolveWorktreeUnsharedPaths(worktree: RuntimeWorktreeConfig): string[] {
	return [...(worktree.unsharedPaths ?? DEFAULT_WORKTREE_UNSHARED_PATHS), ...(worktree.additionalUnsharedPaths ?? [])];
}
