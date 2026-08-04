import { attachContext, createSelfcheckContext, createTrpcScenarioDriver } from "./scenario-api";
import { givenAGrowingTranscriptWhenPolledForLivenessThenCostDoesNotGrowWithHistory } from "./scenarios/givenAGrowingTranscriptWhenPolledForLivenessThenCostDoesNotGrowWithHistory";
import { givenAgentBudgetWhenAProviderCannotBeReadThenTheReadoutSaysUnknownNotZero } from "./scenarios/givenAgentBudgetWhenAProviderCannotBeReadThenTheReadoutSaysUnknownNotZero";
import { givenAgentThatMintsItsOwnSessionIdWhenStartedThenTheCardKeepsItsConversationPointer } from "./scenarios/givenAgentThatMintsItsOwnSessionIdWhenStartedThenTheCardKeepsItsConversationPointer";
import { givenArchivedCardWhenBoardReloadsThenLedgerKeepsItsPointer } from "./scenarios/givenArchivedCardWhenBoardReloadsThenLedgerKeepsItsPointer";
import { givenCardWithADiscoveredSessionWhenItsAgentChangesThenItDoesNotInheritThatSession } from "./scenarios/givenCardWithADiscoveredSessionWhenItsAgentChangesThenItDoesNotInheritThatSession";
import { givenCardWithGoneAgentWhenStartedThenNewAgentRuns } from "./scenarios/givenCardWithGoneAgentWhenStartedThenNewAgentRuns";
import { givenCardWithModelOverrideWhenStartedThenCliReceivesModel } from "./scenarios/givenCardWithModelOverrideWhenStartedThenCliReceivesModel";
import { givenCliContractWhenExercisedThenHelpAndUsageExitCorrectly } from "./scenarios/givenCliContractWhenExercisedThenHelpAndUsageExitCorrectly";
import { givenCompletedEpicWhenArchivedThenItsWorktreeIsRemoved } from "./scenarios/givenCompletedEpicWhenArchivedThenItsWorktreeIsRemoved";
import { givenGeminiNotificationWhenIngestedThenCardParksAndSteerWakesIt } from "./scenarios/givenGeminiNotificationWhenIngestedThenCardParksAndSteerWakesIt";
import { givenLifecycleCardWhenCompletedThenLinkedCardStarts } from "./scenarios/givenLifecycleCardWhenCompletedThenLinkedCardStarts";
import {
	givenReviewCardWhenSteeredThenMovesToInProgress,
	givenSteeredReviewCardWhenReturnsToReviewThenTransitionsRecordRoundTrip,
} from "./scenarios/givenReviewCardWhenSteeredThenMovesToInProgress";
import { givenReviewHookWhenIngestedThenOverseerIsNotified } from "./scenarios/givenReviewHookWhenIngestedThenOverseerIsNotified";
import { givenRunningCardWhenSteeredThenAgentReceivesSubmittedText } from "./scenarios/givenRunningCardWhenSteeredThenAgentReceivesSubmittedText";
import { givenWorktreeShapesWhenEnsuredThenTheyKeepTheExpectedArtifacts } from "./scenarios/givenWorktreeShapesWhenEnsuredThenTheyKeepTheExpectedArtifacts";

interface ScenarioResult {
	name: string;
	status: "pass" | "fail" | "known-fail" | "unexpected-pass";
	durationMs: number;
	error?: string;
	artifactPath?: string;
	knownFailureIssue?: string;
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
	await runScenario(results, "steer a Review card -> moves to In Progress", async () => {
		const context = await createSelfcheckContext();
		try {
			await givenReviewCardWhenSteeredThenMovesToInProgress(
				attachContext(createTrpcScenarioDriver(context), context),
			);
		} finally {
			await context.stop();
		}
	});
	await runScenario(results, "steered Review card records a second Review entry", async () => {
		const context = await createSelfcheckContext();
		try {
			await givenSteeredReviewCardWhenReturnsToReviewThenTransitionsRecordRoundTrip(
				attachContext(createTrpcScenarioDriver(context), context),
			);
		} finally {
			await context.stop();
		}
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
	await runScenario(results, "an archived card keeps its session pointer", async () => {
		await givenArchivedCardWhenBoardReloadsThenLedgerKeepsItsPointer();
	});
	await runScenario(results, "a card keeps the session id its agent minted, with no browser open", async () => {
		const context = await createSelfcheckContext();
		try {
			await givenAgentThatMintsItsOwnSessionIdWhenStartedThenTheCardKeepsItsConversationPointer(
				attachContext(createTrpcScenarioDriver(context), context),
			);
		} finally {
			await context.stop();
		}
	});
	await runScenario(results, "a card that switches agent does not inherit the previous agent's session", async () => {
		const context = await createSelfcheckContext();
		try {
			await givenCardWithADiscoveredSessionWhenItsAgentChangesThenItDoesNotInheritThatSession(
				attachContext(createTrpcScenarioDriver(context), context),
			);
		} finally {
			await context.stop();
		}
	});
	await runScenario(results, "worktree shapes keep env, submodules, and exclude heavy artifacts", async () => {
		await givenWorktreeShapesWhenEnsuredThenTheyKeepTheExpectedArtifacts();
	});
	await runScenario(
		results,
		"completing an epic removes its worktree and hides archived epic workspaces from listing",
		async () => {
			await givenCompletedEpicWhenArchivedThenItsWorktreeIsRemoved();
		},
	);
	await runScenario(results, "a gemini notification parks the card, a steer wakes it", async () => {
		const context = await createSelfcheckContext();
		try {
			await givenGeminiNotificationWhenIngestedThenCardParksAndSteerWakesIt(
				attachContext(createTrpcScenarioDriver(context), context),
			);
		} finally {
			await context.stop();
		}
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
	await runScenario(results, "steering a card delivers the text and submits it", async () => {
		const context = await createSelfcheckContext();
		try {
			await givenRunningCardWhenSteeredThenAgentReceivesSubmittedText(
				attachContext(createTrpcScenarioDriver(context), context),
			);
		} finally {
			await context.stop();
		}
	});
	await runScenario(results, "polling a card stays cheap as its transcript grows", async () => {
		const context = await createSelfcheckContext();
		try {
			await givenAGrowingTranscriptWhenPolledForLivenessThenCostDoesNotGrowWithHistory(
				attachContext(createTrpcScenarioDriver(context), context),
			);
		} finally {
			await context.stop();
		}
	});
	await runScenario(results, "CLI contract: help and usage exits", async () => {
		await givenCliContractWhenExercisedThenHelpAndUsageExitCorrectly();
	});
	await runScenario(results, "CLI budget contract: unknown not zero", async () => {
		await givenAgentBudgetWhenAProviderCannotBeReadThenTheReadoutSaysUnknownNotZero();
	});

	const passed = results.filter((r) => r.status === "pass").length;
	const failed = results.filter((r) => r.status === "fail" || r.status === "unexpected-pass").length;
	const knownFailed = results.filter((r) => r.status === "known-fail").length;
	process.stdout.write(`\nSelfcheck completed: ${passed} passed, ${failed} failed, ${knownFailed} known-failed\n`);

	if (failed > 0) {
		process.exitCode = 1;
	}
}

async function runScenario(
	results: ScenarioResult[],
	name: string,
	run: () => Promise<void>,
	options: { knownFailureIssue?: string } = {},
): Promise<void> {
	process.stdout.write(`START: ${name}\n`);
	const startedAt = Date.now();
	let result: ScenarioResult;
	try {
		await run();
		result = {
			name,
			status: options.knownFailureIssue ? "unexpected-pass" : "pass",
			durationMs: Date.now() - startedAt,
			knownFailureIssue: options.knownFailureIssue,
			error: options.knownFailureIssue
				? `Known failure ${options.knownFailureIssue} passed; remove the marker.`
				: undefined,
		};
	} catch (error) {
		result = {
			name,
			status: options.knownFailureIssue ? "known-fail" : "fail",
			durationMs: Date.now() - startedAt,
			error: formatError(error),
			artifactPath: extractArtifactPath(error),
			knownFailureIssue: options.knownFailureIssue,
		};
	}
	results.push(result);
	process.stdout.write(`${formatScenarioResult(result)}\n`);
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
	const message = error instanceof Error ? error.message : String(error);
	const match = message.match(/artifact=([^;\s]+)/);
	return match?.[1] ?? undefined;
}

void main().catch((error) => {
	process.stderr.write(`selfcheck failed before scenarios ran: ${formatError(error)}\n`);
	process.exit(1);
});
