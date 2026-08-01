import { appendFileSync, type Dirent, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { getCodexRoot } from "../../fixtures/agent-paths";
import { requestJson } from "../../utilities/trpc-request";
import { assertOk, createSelfcheckCard, driverContext, loadState, type ScenarioDriver, waitFor } from "../scenario-api";

/** The stub agent writes a Codex-shaped rollout file under this id for this task. */
const DISCOVERED_SESSION_ID = "5e1fc4ec-0000-4000-8000-000000000001";
/**
 * Card transcripts on this board reach ~20 MB; this uses 60 MB deliberately. A
 * poll costs a few ms of HTTP and session lookup no matter what, so the transcript
 * has to be large enough that history-proportional work would clearly dominate
 * that fixed floor rather than hide inside it. Measured on this suite: bounded
 * reads give a ratio of ~0.9, whole-file re-parsing gives ~4.1.
 */
const GROWN_TRANSCRIPT_BYTES = 60 * 1024 * 1024;
/** Enough polls that per-request HTTP jitter averages out. */
const POLLS_PER_SERIES = 10;
/**
 * How much slower a series over the grown transcript may be than the same series
 * over the small one. Compared as a RATIO, not an absolute budget, so a loaded CI
 * machine slows both series and the gate still holds. Sits between the two
 * measured values with roughly 2x margin on each side.
 */
const MAX_COST_RATIO = 2;
/** Absorbs per-request jitter when both series are only a few ms. */
const RATIO_SLACK_MS = 100;

/**
 * The board polls every session-bearing card for its token usage. That poll used
 * to read the card's whole transcript and re-parse every line from byte zero, so
 * its cost was (cards x accumulated history) and grew for as long as a card ran.
 * At real fleet sizes the event loop saturated and the board stopped serving HTTP
 * while still holding its listening socket — alive to every liveness check, dead
 * to its operator.
 *
 * This pins the cost, not the answer: five earlier fixes to this freeze all
 * shipped green tests, because every one of them asserted what the poll RETURNED
 * and none asserted what it cost. Here the same card is polled repeatedly — first
 * with a small transcript, then after that transcript has grown large — with a
 * record appended before each poll so no cache can hide the work. If the board
 * reads history again, the second series is dramatically slower and this fails.
 */
export async function givenAGrowingTranscriptWhenPolledForLivenessThenCostDoesNotGrowWithHistory(
	driver: ScenarioDriver,
): Promise<void> {
	const context = driverContext(driver);
	const taskId = "selfcheck-transcript-read-cost";
	await driver.createCard({
		card: createSelfcheckCard({
			id: taskId,
			title: "Selfcheck transcript read cost",
			agentId: "codex",
		}),
		column: "backlog",
	});
	await driver.startCard(taskId);

	await waitFor(async () => {
		const state = await loadState(context);
		return state.sessions[taskId]?.agentSessionId === DISCOVERED_SESSION_ID ? true : null;
	}, `session ${taskId} to capture the session id whose transcript the board polls`);

	const transcriptPath = await waitFor(
		async () => findRolloutTranscript(context.instance.homeDir, DISCOVERED_SESSION_ID),
		"the agent to write its transcript",
	);

	const poll = async (): Promise<void> => {
		const { payload } = await requestJson<{ ok: boolean }>({
			baseUrl: context.baseUrl,
			procedure: "runtime.getTaskTokenUsage",
			type: "query",
			workspaceId: context.workspaceId,
			payload: { taskIds: [taskId] },
		});
		assertOk(payload.ok, "The board failed to answer a token-usage poll at all.");
	};

	const measureSeries = async (): Promise<number> => {
		const startedAt = Date.now();
		for (let index = 0; index < POLLS_PER_SERIES; index += 1) {
			// A live agent appends between polls; without that, any cache keyed on
			// the file's identity would answer every poll for free and prove nothing.
			appendFileSync(transcriptPath, transcriptRecord(index), "utf8");
			await poll();
		}
		return Date.now() - startedAt;
	};

	await poll(); // Warm the route so connection setup lands outside both series.
	const smallMs = await measureSeries();
	growTranscript(transcriptPath, GROWN_TRANSCRIPT_BYTES);
	const grownMs = await measureSeries();

	const grownBytes = statSync(transcriptPath).size;
	assertOk(
		grownBytes >= GROWN_TRANSCRIPT_BYTES,
		`Transcript only grew to ${grownBytes} bytes, so this proved nothing about cost.`,
	);
	const budgetMs = smallMs * MAX_COST_RATIO + RATIO_SLACK_MS;
	assertOk(
		grownMs <= budgetMs,
		`${POLLS_PER_SERIES} polls of a card with a ${Math.round(grownBytes / 1024 / 1024)} MB transcript took ` +
			`${grownMs} ms, against ${smallMs} ms for the same polls when the transcript was small ` +
			`(budget ${Math.round(budgetMs)} ms). The board is doing work proportional to accumulated ` +
			"session history again, which is what wedges it at real fleet sizes.",
	);
}

/** A record shaped like real transcript traffic — no parser reads it, only its bulk matters. */
function transcriptRecord(index: number): string {
	return `${JSON.stringify({ type: "selfcheck-padding", index, pad: "x".repeat(160) })}\n`;
}

function growTranscript(path: string, targetBytes: number): void {
	const missing = targetBytes - statSync(path).size;
	if (missing <= 0) {
		return;
	}
	const line = transcriptRecord(0);
	appendFileSync(path, line.repeat(Math.ceil(missing / line.length)), "utf8");
}

function findRolloutTranscript(homeDir: string, sessionId: string): string | null {
	return findFileEndingWith(join(getCodexRoot(homeDir), "sessions"), `${sessionId}.jsonl`);
}

function findFileEndingWith(directory: string, suffix: string): string | null {
	let entries: Dirent[];
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const entry of entries) {
		const candidate = join(directory, entry.name);
		if (entry.isDirectory()) {
			const nested = findFileEndingWith(candidate, suffix);
			if (nested) {
				return nested;
			}
		} else if (entry.name.endsWith(suffix)) {
			return candidate;
		}
	}
	return null;
}
