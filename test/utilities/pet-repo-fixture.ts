import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { createGitTestEnv } from "./git-env";
import { createTempDir } from "./temp-dir";

export interface PetRepoFixture {
	path: string;
	baseCommit: string;
	cleanup(): void;
}

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

export function createPetRepoFixtureCopy(prefix = "kanban-pet-repo-"): PetRepoFixture {
	const temp = createTempDir(prefix);
	const repoPath = join(temp.path, "pet-repo");
	const templatePath = resolve(process.cwd(), "test/fixtures/pet-repo-template");

	mkdirSync(repoPath, { recursive: true });
	cpSync(templatePath, repoPath, {
		recursive: true,
		errorOnExist: false,
	});
	runGit(repoPath, ["init", "-b", "main"]);
	runGit(repoPath, ["add", "."]);
	runGit(repoPath, ["commit", "-qm", "seed pet repo"]);
	const baseCommit = runGit(repoPath, ["rev-parse", "HEAD"]);

	return {
		path: repoPath,
		baseCommit,
		cleanup: temp.cleanup,
	};
}
