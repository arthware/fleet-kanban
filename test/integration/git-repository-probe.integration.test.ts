import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { probeGitRepository } from "../../src/core/git-repository-probe";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

describe("probeGitRepository against real git", () => {
	it("reports yes for a real git repository", () => {
		const { path, cleanup } = createTempDir("kanban-probe-repo-");
		try {
			const init = spawnSync("git", ["init"], { cwd: path, stdio: "ignore", env: createGitTestEnv() });
			expect(init.status).toBe(0);

			expect(probeGitRepository(path)).toBe("yes");
		} finally {
			cleanup();
		}
	});

	it("reports no for a real directory that is not a git repository", () => {
		const { path, cleanup } = createTempDir("kanban-probe-nonrepo-");
		try {
			const plainDir = join(path, "plain");
			mkdirSync(plainDir, { recursive: true });

			expect(probeGitRepository(plainDir)).toBe("no");
		} finally {
			cleanup();
		}
	});
});
