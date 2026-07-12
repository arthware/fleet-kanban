import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createGitTestEnv } from "./git-env";
import { createPetRepoFixtureCopy } from "./pet-repo-fixture";

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv(),
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

describe("GIVEN the pet repo fixture helper", () => {
	it("WHEN it creates a fixture copy THEN the result is a clean committed main-branch repository with the design doc present", () => {
		const fixture = createPetRepoFixtureCopy();
		try {
			expect(runGit(fixture.path, ["branch", "--show-current"])).toBe("main");
			expect(runGit(fixture.path, ["rev-parse", "HEAD"])).toBe(fixture.baseCommit);
			expect(existsSync(join(fixture.path, "docs/design/ENG-123-stub-lifecycle.md"))).toBe(true);
			expect(runGit(fixture.path, ["status", "--short"])).toBe("");
		} finally {
			fixture.cleanup();
		}
	});
});
