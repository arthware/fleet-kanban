import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
	attachContext,
	createSelfcheckContext,
	createTrpcScenarioDriver,
	givenCardWithGoneAgentWhenStartedThenNewAgentRuns,
	givenCardWithModelOverrideWhenStartedThenCliReceivesModel,
	givenCliContractWhenExercisedThenHelpAndUsageExitCorrectly,
	givenLifecycleCardWhenCompletedThenLinkedCardStarts,
	givenReviewHookWhenIngestedThenOverseerIsNotified,
	givenWorktreeShapesWhenEnsuredThenTheyKeepTheExpectedArtifacts,
} from "./scenario-api";

interface ScenarioResult {
	name: string;
	status: "pass" | "fail" | "known-fail" | "unexpected-pass";
	durationMs: number;
	error?: string;
	artifactPath?: string;
	knownFailureIssue?: string;
}

class SelfcheckScenarioError extends Error {
	readonly artifactPath?: string;

	constructor(message: string, options: { artifactPath?: string } = {}) {
		super(message);
		this.name = "SelfcheckScenarioError";
		this.artifactPath = options.artifactPath;
	}
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
	await runScenario(results, "restart a card whose agent is gone", async () => {
		const context = await createSelfcheckContext();
		try {
			await givenCardWithGoneAgentWhenStartedThenNewAgentRuns(
				attachContext(createTrpcScenarioDriver(context), context),
			);
		} finally {
			await context.stop();
		}
	});
	await runScenario(
		results,
		"steer a Review card -> moves to In Progress",
		async () => {
			await runBrowserScenario("review-steering");
		},
		{ knownFailureIssue: "#180" },
	);
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
	await runScenario(results, "a card's model override reaches the CLI", async () => {
		const context = await createSelfcheckContext();
		try {
			await givenCardWithModelOverrideWhenStartedThenCliReceivesModel(
				attachContext(createTrpcScenarioDriver(context), context),
			);
		} finally {
			await context.stop();
		}
	});
	await runScenario(results, "CLI contract: help and usage exits", async () => {
		await givenCliContractWhenExercisedThenHelpAndUsageExitCorrectly();
	});

	for (const result of results) {
		process.stdout.write(`${formatScenarioResult(result)}\n`);
	}
	if (results.some((result) => result.status === "fail" || result.status === "unexpected-pass")) {
		process.exitCode = 1;
	}
}

async function runScenario(
	results: ScenarioResult[],
	name: string,
	run: () => Promise<void>,
	options: { knownFailureIssue?: string } = {},
): Promise<void> {
	const startedAt = Date.now();
	try {
		await run();
		results.push({
			name,
			status: options.knownFailureIssue ? "unexpected-pass" : "pass",
			durationMs: Date.now() - startedAt,
			knownFailureIssue: options.knownFailureIssue,
			error: options.knownFailureIssue
				? `Known failure ${options.knownFailureIssue} passed; remove the marker.`
				: undefined,
		});
	} catch (error) {
		results.push({
			name,
			status: options.knownFailureIssue ? "known-fail" : "fail",
			durationMs: Date.now() - startedAt,
			error: formatError(error),
			artifactPath: extractArtifactPath(error),
			knownFailureIssue: options.knownFailureIssue,
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
			await writeFile(resolve(artifactDir, "playwright-output.txt"), output, "utf8");
			if (output.includes("Executable doesn't exist") || output.includes("playwright install")) {
				throw new SelfcheckScenarioError(
					"Chromium is missing; run: npm --prefix web-ui exec playwright install chromium.",
					{ artifactPath: artifactDir },
				);
			}
			throw new SelfcheckScenarioError("Review card did not move to In Progress after steering.", {
				artifactPath: artifactDir,
			});
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
		throw new Error(`web-ui build failed: ${compactCommandOutput(`${result.stdout}\n${result.stderr}`)}`);
	}
}

function formatScenarioResult(result: ScenarioResult): string {
	if (result.status === "pass") {
		return `PASS ${result.name} ${result.durationMs}ms`;
	}
	if (result.status === "known-fail") {
		return `KNOWN-FAIL ${result.name} -> ${result.knownFailureIssue} ${result.durationMs}ms - ${formatFailureSuffix(result)}`;
	}
	if (result.status === "unexpected-pass") {
		return `UNEXPECTED-PASS ${result.name} -> ${result.knownFailureIssue} ${result.durationMs}ms - ${result.error}`;
	}
	return `FAIL ${result.name} ${result.durationMs}ms - ${formatFailureSuffix(result)}`;
}

function formatFailureSuffix(result: ScenarioResult): string {
	const artifact = result.artifactPath ? ` (artifact: ${result.artifactPath})` : "";
	return `${result.error ?? "Scenario failed."}${artifact}`;
}

function formatError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\s+/g, " ").trim();
}

function extractArtifactPath(error: unknown): string | undefined {
	if (error instanceof SelfcheckScenarioError) {
		return error.artifactPath;
	}
	const message = error instanceof Error ? error.message : String(error);
	const match = message.match(/artifact=([^;\s]+)/);
	return match?.[1] ?? undefined;
}

function compactCommandOutput(output: string): string {
	const lines = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return lines.slice(-4).join(" | ");
}

void main().catch((error) => {
	process.stderr.write(`selfcheck failed before scenarios ran: ${formatError(error)}\n`);
	process.exit(1);
});
