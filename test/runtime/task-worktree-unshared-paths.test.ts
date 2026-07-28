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
});
