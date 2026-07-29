import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
	attachContext,
	createSelfcheckContext,
	createTrpcScenarioDriver,
	givenCliContractWhenExercisedThenHelpAndUsageExitCorrectly,
	givenLifecycleCardWhenCompletedThenLinkedCardStarts,
	givenReviewHookWhenIngestedThenOverseerIsNotified,
	givenWorktreeShapesWhenEnsuredThenTheyKeepTheExpectedArtifacts,
} from "./scenario-api";

interface ScenarioResult {
	name: string;
	ok: boolean;
	durationMs: number;
	error?: string;
	artifactPath?: string;
}

async function main(): Promise<void> {
	const results: ScenarioResult[] = [];
	await runScenario(results, "card lifecycle: start -> review -> done -> linked auto-start", async () => {
		const context = await createSelfcheckContext();
		try {
			await givenLifecycleCardWhenCompletedThenLinkedCardStarts(
				attachContext(createTrpcScenarioDriver(context), context),
			);
		} finally {
			await context.stop();
		}
	});
	await runScenario(results, "steer a Review card -> moves to In Progress", async () => {
		await runBrowserScenario("review-steering");
	});
	await runScenario(results, "review ping reaches the overseer session", async () => {
		const context = await createSelfcheckContext();
		try {
			await givenReviewHookWhenIngestedThenOverseerIsNotified(
				attachContext(createTrpcScenarioDriver(context), context),
			);
		} finally {
			await context.stop();
		}
	});
	await runScenario(results, "worktree shapes keep env, submodules, and exclude heavy artifacts", async () => {
		await givenWorktreeShapesWhenEnsuredThenTheyKeepTheExpectedArtifacts();
	});
	await runScenario(results, "CLI contract: help and usage exits", async () => {
		await givenCliContractWhenExercisedThenHelpAndUsageExitCorrectly();
	});

	for (const result of results) {
		const status = result.ok ? "PASS" : "FAIL";
		const suffix = result.ok
			? ""
			: ` - ${result.error}${result.artifactPath ? ` (artifact: ${result.artifactPath})` : ""}`;
		process.stdout.write(`${status} ${result.name} ${result.durationMs}ms${suffix}\n`);
	}
	if (results.some((result) => !result.ok)) {
		process.exitCode = 1;
	}
}

async function runScenario(results: ScenarioResult[], name: string, run: () => Promise<void>): Promise<void> {
	const startedAt = Date.now();
	try {
		await run();
		results.push({ name, ok: true, durationMs: Date.now() - startedAt });
	} catch (error) {
		results.push({
			name,
			ok: false,
			durationMs: Date.now() - startedAt,
			error: formatError(error),
			artifactPath: extractArtifactPath(error),
		});
	}
}

async function runBrowserScenario(name: string): Promise<void> {
	const context = await createSelfcheckContext();
	const artifactDir = resolve(process.cwd(), ".selfcheck-artifacts", `${name}-${Date.now()}`);
	try {
		await ensureBuiltUi();
		await mkdir(artifactDir, { recursive: true });
		const result = spawnSync(
			"npm",
			[
				"exec",
				"--",
				"playwright",
				"test",
				"tests/selfcheck.spec.ts",
				"--config",
				"playwright.selfcheck.config.ts",
				"--reporter",
				"list",
			],
			{
				cwd: resolve(process.cwd(), "web-ui"),
				encoding: "utf8",
				env: {
					...process.env,
					KANBAN_SELFCHECK_BASE_URL: context.baseUrl,
					KANBAN_SELFCHECK_WORKSPACE_ID: context.workspaceId,
					KANBAN_SELFCHECK_HOME: context.instance.homeDir,
					KANBAN_SELFCHECK_ARTIFACT_DIR: artifactDir,
				},
			},
		);
		if (result.status !== 0) {
			const output = `${result.stdout}\n${result.stderr}`;
			if (output.includes("Executable doesn't exist") || output.includes("playwright install")) {
				throw new Error(
					`Chromium is missing; run: npm --prefix web-ui exec playwright install chromium; artifact=${artifactDir}`,
				);
			}
			throw new Error(
				`Review card did not move to In Progress after steering; ${compactOutput(output)}; artifact=${artifactDir}`,
			);
		}
	} finally {
		await context.stop();
	}
}

async function ensureBuiltUi(): Promise<void> {
	if (existsSync(resolve(process.cwd(), "web-ui/dist/index.html"))) {
		return;
	}
	const result = spawnSync("npm", ["--prefix", "web-ui", "run", "build"], {
		encoding: "utf8",
		env: process.env,
	});
	if (result.status !== 0) {
		throw new Error(`web-ui build failed: ${compactOutput(`${result.stdout}\n${result.stderr}`)}`);
	}
}

function compactOutput(output: string): string {
	const lines = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("Running ") && !line.startsWith("Using config"));
	return lines.slice(-8).join(" | ");
}

function formatError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\s+/g, " ").trim();
}

function extractArtifactPath(error: unknown): string | undefined {
	const message = error instanceof Error ? error.message : String(error);
	const match = message.match(/artifact=([^;\s]+)/);
	return match?.[1] ?? undefined;
}

void main().catch((error) => {
	process.stderr.write(`selfcheck failed before scenarios ran: ${formatError(error)}\n`);
	process.exit(1);
});
