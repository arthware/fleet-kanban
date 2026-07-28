import { describe, expect, it } from "vitest";

import {
	DEFAULT_WORKTREE_UNSHARED_PATHS,
	shouldKeepPathUnsharedInWorktree,
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
