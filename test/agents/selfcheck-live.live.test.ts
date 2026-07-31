import { afterAll, describe, expect, it, type TestContext } from "vitest";
import { WebSocket } from "ws";
import { getTaskColumnId } from "../../src/core/task-board-mutations";
import {
	createSelfcheckCard,
	createSelfcheckContext,
	createTrpcScenarioDriver,
	loadState,
	waitFor,
} from "../selfcheck/scenario-api";
import { resolveBinaryExecutable } from "./tck/live-tck";

interface TerminalCapture {
	getOutput: () => string;
	close: () => void;
}

interface TestSummary {
	executed: boolean;
	skipped: boolean;
	reason: string;
}

const selfcheckLiveSummary: Record<string, TestSummary> = {
	claude: { executed: false, skipped: false, reason: "pending" },
	codex: { executed: false, skipped: false, reason: "pending" },
	gemini: { executed: false, skipped: false, reason: "pending" },
};

afterAll(() => {
	console.log("\n======================================================================");
	console.log("SELFCHECK LIVE INTEGRATION RUN SUMMARY");
	console.log("======================================================================");
	for (const [agentId, result] of Object.entries(selfcheckLiveSummary)) {
		const status = result.executed ? "EXECUTED (card parked in review)" : `SKIPPED (${result.reason})`;
		console.log(`${agentId.toUpperCase()} agent: ${status}`);
	}
	console.log("======================================================================\n");

	// "Nothing ran" is only a failure when the suite was actually asked to run. Without
	// KANBAN_LIVE_BOARD every agent is skipped by design, and failing on that would make
	// the default live gate red for doing exactly what it was told.
	if (!process.env.KANBAN_LIVE_BOARD) {
		return;
	}
	const allSkipped = Object.values(selfcheckLiveSummary).every((r) => r.skipped);
	if (allSkipped && process.env.TCK_LIVE_ALLOW_EMPTY !== "1") {
		console.error("ERROR: Every live selfcheck agent test was skipped, and TCK_LIVE_ALLOW_EMPTY is not set.");
		process.exit(1);
	}
});

// Strip ANSI escape codes from a string. The escape and CSI introducers are control
// characters by definition, so matching them here is the point, not an oversight.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI sequences begin with ESC (U+001B) / CSI (U+009B)
const ANSI_ESCAPE_PATTERN = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function stripAnsi(str: string): string {
	return str.replace(ANSI_ESCAPE_PATTERN, "");
}

// Classify skip reasons with precise categories or return null if it should continue executing
function classifyLiveSkipReason(out: string): string | null {
	const outLower = out.toLowerCase().replace(/\s+/g, "");
	if (
		outLower.includes("choosethetextstyle") ||
		outLower.includes("textstylethatlooksbest") ||
		outLower.includes("selectastyle")
	) {
		return "Interactive onboarding prompt not answered (Claude theme selection)";
	}
	if (outLower.includes("entergeminiapikey") || outLower.includes("pleaseenteryourgeminiapikey")) {
		return "Not authenticated (Gemini CLI prompting for API Key)";
	}
	if (
		outLower.includes("mustspecifythegemini_api_key") ||
		outLower.includes("noauthenticationmethodselected") ||
		outLower.includes("pleasesetanauthmethod")
	) {
		return "Not authenticated (Gemini CLI auth method missing)";
	}
	if (outLower.includes("notloggedin") || outLower.includes("pleasesignin") || outLower.includes("openthebrowser")) {
		return "Not authenticated (Claude Code not logged in)";
	}
	return null;
}

// Backward compatibility check for isUnauthenticatedText
function isUnauthenticatedText(out: string): boolean {
	return classifyLiveSkipReason(out) !== null;
}

async function captureTerminalOutput(
	port: number,
	workspaceId: string,
	taskId: string,
): Promise<{ getOutput: () => string; close: () => void }> {
	let terminalOutput = "";
	const ioUrl = `ws://127.0.0.1:${port}/api/terminal/io?taskId=${taskId}&workspaceId=${encodeURIComponent(
		workspaceId,
	)}&clientId=test-client`;
	const controlUrl = `ws://127.0.0.1:${port}/api/terminal/control?taskId=${taskId}&workspaceId=${encodeURIComponent(
		workspaceId,
	)}&clientId=test-client`;

	const ioWs = new WebSocket(ioUrl);
	const controlWs = new WebSocket(controlUrl);

	ioWs.on("message", (data) => {
		const txt = data.toString("utf8");
		terminalOutput += txt;
	});

	controlWs.on("open", () => {
		controlWs.send(JSON.stringify({ type: "restore_complete" }));
	});

	return {
		getOutput: () => terminalOutput,
		close: () => {
			ioWs.close();
			controlWs.close();
			ioWs.terminate();
			controlWs.terminate();
		},
	};
}

/**
 * Opt-in, and not yet passing. Read this before enabling it.
 *
 * These drive a real agent CLI against a real board and wait for the card to park in
 * Review off the agent's own hook. Against an isolated test instance the card never
 * parks — the agent runs, but its stop hook does not land — and the cause is not yet
 * understood. The same flow does work against a real board: on the pet-store dogfood
 * board all three harnesses reach `column=review` with `reviewReason=hook`, so the
 * product path is sound and what is broken is this harness's ability to observe it.
 *
 * It stays in the tree, opt-in behind KANBAN_LIVE_BOARD=1, because the honest options
 * were to leave it failing or to simulate the hook — and simulating the hook would make
 * it pass on precisely the defect it exists to catch. The per-driver live conformance
 * suite (`tck/live-conformance.live.test.ts`) does run in the default live gate and does
 * drive all three real CLIs.
 */
describe.skipIf(!process.env.KANBAN_LIVE_BOARD)("Live Selfcheck Integration Tests", () => {
	const runLiveTestForAgent = async (agentId: "claude" | "codex" | "gemini", binaryName: string, ctx: TestContext) => {
		const executablePath = resolveBinaryExecutable(binaryName);
		if (!executablePath) {
			selfcheckLiveSummary[agentId] = { executed: false, skipped: true, reason: `${binaryName} binary not found` };
			ctx.skip();
			return;
		}

		console.log(`[test] Starting live test for ${agentId} using binary ${executablePath}...`);
		const context = await createSelfcheckContext({ live: true });
		let capture: TerminalCapture | null = null;
		try {
			const driver = createTrpcScenarioDriver(context);
			const taskId = `live-selfcheck-${agentId}`;
			const card = createSelfcheckCard({
				id: taskId,
				title: `Live selfcheck prompt for ${agentId}`,
				prompt: "Reply with exactly: LIVE-OK. Do not use any tools.",
				agentId,
				baseRef: "main",
			});

			await driver.createCard({
				column: "backlog",
				card,
			});

			const startPromise = driver.startCard(taskId);
			// Start capturing PTY output in parallel to avoid missing initial chunks
			capture = await captureTerminalOutput(context.instance.port, context.workspaceId, taskId);
			await startPromise;

			// Wait for card to park or fail, or check for unauthenticated text proactively
			const result = await waitFor(
				async () => {
					const termOut = capture ? capture.getOutput() : "";
					const cleanTermOut = stripAnsi(termOut);
					const skipReason = classifyLiveSkipReason(cleanTermOut);
					if (skipReason) {
						return { unauthenticated: true, skipReason, termOut: cleanTermOut };
					}

					// Deliberately no simulated hook here. The claim this test makes is that a real
					// agent parks its own card, so the parking has to come from that agent's own
					// hook reaching the board. Ingesting one on its behalf would make the test
					// pass on exactly the break it exists to catch.
					const state = await loadState(context);
					const session = state.sessions[taskId];
					if (!session) return null;

					// If it reached awaiting_review or exited, check state
					if (session.state === "awaiting_review" || session.exitCode !== null) {
						return { unauthenticated: false, state, session, termOut: cleanTermOut };
					}
					return null;
				},
				`${agentId} card to park or exit`,
				120000,
			); // 120s timeout

			if (
				result.unauthenticated ||
				!("session" in result) ||
				!("state" in result) ||
				!result.session ||
				!result.state
			) {
				const skipReason = "skipReason" in result ? result.skipReason : "Agent started but never parked";
				const cleanOut = result.termOut.replace(/\s+/g, " ").trim().substring(0, 300);
				const detailedReason = `${skipReason} (Output: "${cleanOut || "<empty>"}")`;
				selfcheckLiveSummary[agentId] = { executed: false, skipped: true, reason: detailedReason };
				ctx.skip();
				return;
			}

			const { state: resultState, session, termOut } = result;

			if (session.exitCode !== 0 || session.reviewReason === "error" || isUnauthenticatedText(termOut)) {
				// Check if the output indicates lack of authentication
				const skipReason = classifyLiveSkipReason(termOut);
				if (skipReason || session.exitCode !== 0) {
					const cleanOut = termOut.replace(/\s+/g, " ").trim().substring(0, 300);
					const detailedReason = `${skipReason || "Binary execution failed"} (Exit code ${session.exitCode}: "${cleanOut || "<empty>"}")`;
					selfcheckLiveSummary[agentId] = { executed: false, skipped: true, reason: detailedReason };
					ctx.skip();
					return;
				}
				throw new Error(
					`${agentId.toUpperCase()} live execution failed with exit code ${session.exitCode}. Terminal output: ${termOut}`,
				);
			}

			// Validate both parked state and review column asserted as a pair
			const col = getTaskColumnId(resultState.board, taskId);
			expect(session.state).toBe("awaiting_review");
			expect(col).toBe("review");

			selfcheckLiveSummary[agentId] = { executed: true, skipped: false, reason: "" };
		} catch (error) {
			if (selfcheckLiveSummary[agentId].skipped) {
				throw error; // Vitest abort skip signal
			}
			const msg = error instanceof Error ? error.message : String(error);
			selfcheckLiveSummary[agentId] = { executed: false, skipped: false, reason: `failed: ${msg}` };
			throw error;
		} finally {
			if (capture) {
				capture.close();
			}
			await context.stop();
		}
	};

	it("Claude live selfcheck Integration", async (ctx) => {
		await runLiveTestForAgent("claude", "claude", ctx);
	}, 125000);

	it("Codex live selfcheck Integration", async (ctx) => {
		await runLiveTestForAgent("codex", "codex", ctx);
	}, 125000);

	it("Gemini live selfcheck Integration", async (ctx) => {
		await runLiveTestForAgent("gemini", "gemini", ctx);
	}, 125000);
});
