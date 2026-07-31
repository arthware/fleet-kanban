import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { createGitTestEnv } from "../../utilities/git-env";
import { assertOk } from "../scenario-api";

export async function givenCliContractWhenExercisedThenHelpAndUsageExitCorrectly(): Promise<void> {
	const help = spawnSync(
		process.execPath,
		["--import", resolveTsxLoader(), resolve(process.cwd(), "src/cli.ts"), "--help"],
		{
			encoding: "utf8",
			env: createGitTestEnv(),
		},
	);
	assertOk(help.status === 0, `kanban --help exited ${String(help.status)}: ${help.stderr}`);
	assertOk(help.stdout.includes("Usage:"), "kanban --help did not print usage.");
	const usage = spawnSync(
		process.execPath,
		["--import", resolveTsxLoader(), resolve(process.cwd(), "src/cli.ts"), "task", "start"],
		{
			encoding: "utf8",
			env: createGitTestEnv(),
		},
	);
	assertOk(usage.status !== 0, "kanban task start without --task-id exited zero.");
}

function resolveTsxLoader(): string {
	return new URL(import.meta.resolve("tsx")).href;
}
