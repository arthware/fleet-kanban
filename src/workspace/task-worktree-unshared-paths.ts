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
