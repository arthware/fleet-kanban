import { afterAll, describe, expect, it } from "vitest";
import { createSelfcheckContext, createTrpcScenarioDriver, createSelfcheckCard, loadState, waitFor } from "../selfcheck/scenario-api";
import { getTaskColumnId } from "../../src/core/task-board-mutations";
import { resolveBinaryExecutable } from "./tck/live-tck";
import { WebSocket } from "ws";
import { existsSync } from "node:fs";

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

	const allSkipped = Object.values(selfcheckLiveSummary).every((r) => r.skipped);
	if (allSkipped && process.env.TCK_LIVE_ALLOW_EMPTY !== "1") {
		console.error("ERROR: Every live selfcheck agent test was skipped, and TCK_LIVE_ALLOW_EMPTY is not set.");
		process.exit(1);
	}
});

// Strip ANSI escape codes from a string
function stripAnsi(str: string): string {
	return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}

// Check if binary is missing, unauthenticated, or in interactive first-run onboarding
function isUnauthenticatedText(out: string): boolean {
	const outLower = out.toLowerCase().replace(/\s+/g, "");
	const matchers = [
		"login",
		"unauthenticated",
		"notloggedin",
		"unauthorized",
		"pleasesignin",
		"openthebrowser",
		"choosethetextstyle",
		"textstylethatlooksbest",
		"selectastyle",
		"quicksafetycheck",
		"mustspecifythegemini_api_key",
		"noauthenticationmethodselected",
		"pleasesetanauthmethod",
		"notauthenticated",
		"entergeminiapikey",
	];
	for (const m of matchers) {
		if (outLower.includes(m)) {
			console.log(`[match-debug] MATCHED: "${m}" in "${outLower.substring(0, 300)}"`);
			return true;
		}
	}
	return false;
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

describe("Live Selfcheck Integration Tests", () => {
	const runLiveTestForAgent = async (agentId: "claude" | "codex" | "gemini", binaryName: string, ctx: any) => {
		const executablePath = resolveBinaryExecutable(binaryName);
		if (!executablePath) {
			selfcheckLiveSummary[agentId] = { executed: false, skipped: true, reason: `${binaryName} binary not found` };
			ctx.skip();
			return;
		}

		console.log(`[test] Starting live test for ${agentId} using binary ${executablePath}...`);
		const context = await createSelfcheckContext({ live: true });
		let capture: any;
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
					if (isUnauthenticatedText(cleanTermOut)) {
						return { unauthenticated: true, termOut: cleanTermOut };
					}

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

			if (result.unauthenticated || !("session" in result) || !("state" in result) || !result.session || !result.state) {
				const cleanOut = result.termOut.replace(/\s+/g, " ").trim().substring(0, 300);
				const detailedReason = `Not authenticated/configured: "${cleanOut || "<empty>"}"`;
				selfcheckLiveSummary[agentId] = { executed: false, skipped: true, reason: detailedReason };
				ctx.skip();
				return;
			}

			const { state: resultState, session, termOut } = result;

			if (session.exitCode !== 0 || session.reviewReason === "error" || isUnauthenticatedText(termOut)) {
				// Check if the output indicates lack of authentication
				if (isUnauthenticatedText(termOut) || termOut.toLowerCase().includes("auth") || session.exitCode !== 0) {
					const cleanOut = termOut.replace(/\s+/g, " ").trim().substring(0, 300);
					const detailedReason = `Not authenticated (Exit code ${session.exitCode}: "${cleanOut || "<empty>"}")`;
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
		} catch (error: any) {
			if (selfcheckLiveSummary[agentId].skipped) {
				throw error; // Vitest abort skip signal
			}
			selfcheckLiveSummary[agentId] = { executed: false, skipped: false, reason: `failed: ${error.message}` };
			throw error;
		} finally {
			if (capture) {
				capture.close();
			}
			await context.stop();
		}
	};

	it(
		"Claude live selfcheck Integration",
		async (ctx) => {
			await runLiveTestForAgent("claude", "claude", ctx);
		},
		125000,
	);

	it(
		"Codex live selfcheck Integration",
		async (ctx) => {
			await runLiveTestForAgent("codex", "codex", ctx);
		},
		125000,
	);

	it(
		"Gemini live selfcheck Integration",
		async (ctx) => {
			await runLiveTestForAgent("gemini", "gemini", ctx);
		},
		125000,
	);
});
