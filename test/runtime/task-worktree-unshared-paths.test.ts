import { describe, expect, it } from "vitest";

import {
	collectTrackedDirectories,
	DEFAULT_WORKTREE_UNSHARED_PATHS,
	isPathInsideTrackedSourceTree,
	isWorktreeEnvFilePath,
	resolveWorktreeUnsharedPaths,
	shouldKeepPathUnsharedInWorktree,
	shouldMirrorIgnoredPathIntoWorktree,
} from "../../src/workspace/task-worktree-unshared-paths";

describe("shouldKeepPathUnsharedInWorktree", () => {
	it.each([
		["node_modules", true],
		["node_modules/", true],
		["packages/core-model/node_modules", true],
		["packages/core-model/node_modules/", true],
		["dist", true],
		["web-ui/dist", true],
		["apps/web/.next", true],
		["apps/web/.turbo/logs", true],
		["packages/core/tsconfig.tsbuildinfo", true],
		["packages/core/tsconfig.build.tsbuildinfo", true],
		["packages/core/build.log", false],
		["packages/core/app.js.map", false],
		[".env", false],
		["packages/core-model/src/node_modules-helper.ts", false],
		["distribution", false],
		["buildkite", false],
		["packages/core/tsbuildinfo.txt", false],
	])("given path %s, when default unshared names are checked, then match is %s", (relativePath, expected) => {
		expect(shouldKeepPathUnsharedInWorktree(relativePath, DEFAULT_WORKTREE_UNSHARED_PATHS)).toBe(expected);
	});

	it("given a repo-defined list, when a default name is omitted, then the repo list replaces the default", () => {
		const repoDefinedUnsharedPaths = ["dist"];

		expect(shouldKeepPathUnsharedInWorktree("dist", repoDefinedUnsharedPaths)).toBe(true);
		expect(shouldKeepPathUnsharedInWorktree("node_modules", repoDefinedUnsharedPaths)).toBe(false);
	});

	it("given repo-defined suffix globs, when paths are checked, then matching basenames stay unshared", () => {
		const repoDefinedUnsharedPaths = ["*.log", "*.map"];

		expect(shouldKeepPathUnsharedInWorktree("logs/build.log", repoDefinedUnsharedPaths)).toBe(true);
		expect(shouldKeepPathUnsharedInWorktree("web-ui/dist/app.js.map", repoDefinedUnsharedPaths)).toBe(true);
		expect(shouldKeepPathUnsharedInWorktree("logs/catalog", repoDefinedUnsharedPaths)).toBe(false);
		expect(shouldKeepPathUnsharedInWorktree("web-ui/map", repoDefinedUnsharedPaths)).toBe(false);
	});
});

describe("collectTrackedDirectories", () => {
	it("given tracked files, when directories are collected, then every ancestor directory below the repo root is listed", () => {
		const trackedDirectories = collectTrackedDirectories([
			"README.md",
			"packages/skill-runner/src/lib/loader.ts",
			"packages/viewer/package.json",
		]);

		expect([...trackedDirectories].sort()).toEqual([
			"packages",
			"packages/skill-runner",
			"packages/skill-runner/src",
			"packages/skill-runner/src/lib",
			"packages/viewer",
		]);
	});

	it("given only root-level tracked files, when directories are collected, then the repo root is not listed as a tracked directory", () => {
		const trackedDirectories = collectTrackedDirectories(["README.md", ".gitignore"]);

		expect(trackedDirectories.size).toBe(0);
	});
});

describe("isPathInsideTrackedSourceTree", () => {
	const trackedDirectories = collectTrackedDirectories([
		"README.md",
		".gitignore",
		"packages/skill-runner/package.json",
		"packages/skill-runner/src/index.ts",
		"packages/viewer/src/components/app.tsx",
	]);

	it("given a root-level ignored path, when the repo root holds tracked files, then it is not inside a tracked source tree", () => {
		expect(isPathInsideTrackedSourceTree(".env", trackedDirectories)).toBe(false);
		expect(isPathInsideTrackedSourceTree(".env.local", trackedDirectories)).toBe(false);
		expect(isPathInsideTrackedSourceTree("node_modules", trackedDirectories)).toBe(false);
	});

	it("given an ignored artifact nested in a tracked source directory, when it is checked, then it is inside a tracked source tree", () => {
		expect(isPathInsideTrackedSourceTree("packages/skill-runner/src/generated", trackedDirectories)).toBe(true);
		expect(isPathInsideTrackedSourceTree("packages/skill-runner/src/generated/", trackedDirectories)).toBe(true);
		expect(isPathInsideTrackedSourceTree("packages/viewer/src/tailwind.build.css", trackedDirectories)).toBe(true);
	});

	it("given a tracked directory whose own files live deeper, when a sibling artifact is checked, then it is still inside a tracked source tree", () => {
		expect(isPathInsideTrackedSourceTree("packages/viewer/src/schema.graphql", trackedDirectories)).toBe(true);
	});

	it("given an ignored path in a subtree git tracks nothing in, when it is checked, then it is outside every tracked source tree", () => {
		expect(isPathInsideTrackedSourceTree("scratch/notes", trackedDirectories)).toBe(false);
		expect(isPathInsideTrackedSourceTree("vendor-cache/artifacts", trackedDirectories)).toBe(false);
	});

	it("given an ignored path deeper inside a tracked package, when an intermediate directory tracks nothing, then it is still inside a tracked source tree", () => {
		expect(isPathInsideTrackedSourceTree("packages/skill-runner/coverage/lcov.info", trackedDirectories)).toBe(true);
	});
});

describe("isWorktreeEnvFilePath", () => {
	it.each([
		[".env", true],
		[".env.local", true],
		["apps/lab/.env.local", true],
		["apps/lab/.env.test-integration", true],
		["apps/lab/.env.development", true],
		[".envrc", false],
		["apps/lab/env.local", false],
		["apps/lab/foo.env", false],
		["apps/lab/.env/local", false],
	])("given path %s, when env file matching is checked, then match is %s", (relativePath, expected) => {
		expect(isWorktreeEnvFilePath(relativePath)).toBe(expected);
	});
});

describe("shouldMirrorIgnoredPathIntoWorktree", () => {
	const trackedDirectories = collectTrackedDirectories([
		"README.md",
		"packages/skill-runner/package.json",
		"packages/skill-runner/src/index.ts",
		"apps/lab/package.json",
		"apps/lab/src/index.ts",
	]);

	it("given a root-level env file, when mirroring is decided, then it is mirrored into the worktree", () => {
		const mirrored = shouldMirrorIgnoredPathIntoWorktree(".env", {
			unsharedPaths: DEFAULT_WORKTREE_UNSHARED_PATHS,
			trackedDirectories,
		});

		expect(mirrored).toBe(true);
	});

	it.each(["apps/lab/.env.local", "apps/lab/.env.test-integration", "apps/lab/.env.development"])(
		"given nested env file %s inside a tracked package, when mirroring is decided, then it is mirrored into the worktree",
		(relativePath) => {
			const mirrored = shouldMirrorIgnoredPathIntoWorktree(relativePath, {
				unsharedPaths: DEFAULT_WORKTREE_UNSHARED_PATHS,
				trackedDirectories,
			});

			expect(mirrored).toBe(true);
		},
	);

	it("given nested env files are exempt by basename, when a similar non-env path is decided, then the structural rule still keeps it local", () => {
		const mirrored = shouldMirrorIgnoredPathIntoWorktree("apps/lab/.envrc", {
			unsharedPaths: DEFAULT_WORKTREE_UNSHARED_PATHS,
			trackedDirectories,
		});

		expect(mirrored).toBe(false);
	});

	it("given a nested env file is explicitly unshared, when mirroring is decided, then unsharedPaths wins over the env exemption", () => {
		const mirrored = shouldMirrorIgnoredPathIntoWorktree("apps/lab/.env.local", {
			unsharedPaths: [".env.local"],
			trackedDirectories,
		});

		expect(mirrored).toBe(false);
	});

	it("given a generated artifact under a tracked source tree, when mirroring is decided, then it stays local to the repo", () => {
		const mirrored = shouldMirrorIgnoredPathIntoWorktree("packages/skill-runner/src/generated", {
			unsharedPaths: DEFAULT_WORKTREE_UNSHARED_PATHS,
			trackedDirectories,
		});

		expect(mirrored).toBe(false);
	});

	it("given an unshared name at the repo root, when mirroring is decided, then the name rule still keeps it local", () => {
		const mirrored = shouldMirrorIgnoredPathIntoWorktree("node_modules", {
			unsharedPaths: DEFAULT_WORKTREE_UNSHARED_PATHS,
			trackedDirectories,
		});

		expect(mirrored).toBe(false);
	});

	it("given a repo that shares node_modules, when the path sits at the repo root, then it is mirrored again", () => {
		const mirrored = shouldMirrorIgnoredPathIntoWorktree("node_modules", {
			unsharedPaths: ["dist"],
			trackedDirectories,
		});

		expect(mirrored).toBe(true);
	});

	it("given a repo that shares a nested path explicitly, when mirroring is decided, then the structural rule steps aside", () => {
		const mirrored = shouldMirrorIgnoredPathIntoWorktree("packages/skill-runner/.env.local", {
			unsharedPaths: DEFAULT_WORKTREE_UNSHARED_PATHS,
			trackedDirectories,
			sharedPaths: ["packages/skill-runner/.env.local"],
		});

		expect(mirrored).toBe(true);
	});

	it("given a shared directory, when a path below it is decided, then the whole subtree is mirrored", () => {
		const mirrored = shouldMirrorIgnoredPathIntoWorktree("packages/skill-runner/secrets/token", {
			unsharedPaths: DEFAULT_WORKTREE_UNSHARED_PATHS,
			trackedDirectories,
			sharedPaths: ["packages/skill-runner/secrets"],
		});

		expect(mirrored).toBe(true);
	});

	it("given a shared path that does not match, when mirroring is decided, then the structural rule still applies", () => {
		const mirrored = shouldMirrorIgnoredPathIntoWorktree("packages/skill-runner/src/generated", {
			unsharedPaths: DEFAULT_WORKTREE_UNSHARED_PATHS,
			trackedDirectories,
			sharedPaths: ["packages/skill-runner/.env.local"],
		});

		expect(mirrored).toBe(false);
	});
});

describe("resolveWorktreeUnsharedPaths", () => {
	it("given no worktree config, when the list is resolved, then the built-in defaults apply", () => {
		expect(resolveWorktreeUnsharedPaths({})).toEqual([...DEFAULT_WORKTREE_UNSHARED_PATHS]);
	});

	it("given unsharedPaths, when the list is resolved, then it replaces the built-in defaults", () => {
		expect(resolveWorktreeUnsharedPaths({ unsharedPaths: ["dist"] })).toEqual(["dist"]);
	});

	it("given additionalUnsharedPaths only, when the list is resolved, then it extends the built-in defaults", () => {
		expect(resolveWorktreeUnsharedPaths({ additionalUnsharedPaths: ["coverage"] })).toEqual([
			...DEFAULT_WORKTREE_UNSHARED_PATHS,
			"coverage",
		]);
	});

	it("given both keys, when the list is resolved, then the additions extend the replaced list", () => {
		expect(resolveWorktreeUnsharedPaths({ unsharedPaths: ["dist"], additionalUnsharedPaths: ["coverage"] })).toEqual([
			"dist",
			"coverage",
		]);
	});
});
