#!/usr/bin/env node
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...options,
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `${command} ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

async function notifyReview() {
	const taskId = process.env.KANBAN_HOOK_TASK_ID;
	const workspaceId = process.env.KANBAN_HOOK_WORKSPACE_ID;
	const port = process.env.KANBAN_RUNTIME_PORT;
	if (!taskId || !workspaceId || !port) {
		return;
	}

	const response = await fetch(`http://127.0.0.1:${port}/api/trpc/hooks.ingest`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			taskId,
			workspaceId,
			event: "to_review",
			metadata: {
				source: "stub-agent",
				activityText: "Stub agent finished",
				finalMessage: "Stub agent committed deterministic work",
				hookEventName: "stop",
			},
		}),
	});
	if (!response.ok) {
		throw new Error(`Hook ingest failed: ${response.status} ${await response.text()}`);
	}
}

const cwd = process.cwd();
const taskId = process.env.KANBAN_HOOK_TASK_ID ?? "unknown-task";
const markerPath = join(cwd, "stub-agent-output.txt");

// Codex and Gemini mint their own session id and only reveal it by writing a
// transcript once they have booted, so the runtime has to discover it after
// spawn. Impersonate that: write a Codex-shaped rollout file naming this cwd, so
// the discovery path has something real to find and the id it settles on is
// known to the scenario asserting on it.
const STUB_DISCOVERED_SESSION_ID = "5e1fc4ec-0000-4000-8000-000000000001";
// Scenarios that assert on a discovered session — or on what the board does with
// the transcript behind it. One list, because both halves of the impersonation
// (write the rollout, stay alive for the discovery poll) must cover the same tasks.
const DISCOVERABLE_SESSION_TASK_IDS = new Set([
	"selfcheck-discovered-session-id",
	"selfcheck-transcript-read-cost",
	"selfcheck-agent-switch-identity",
]);
const EARLY_REVIEW_TASK_IDS = new Set(["selfcheck-steer-review", "selfcheck-steer-review-history"]);
if (DISCOVERABLE_SESSION_TASK_IDS.has(taskId) && process.env.HOME) {
	const sessionsDir = join(process.env.HOME, ".codex", "sessions", "2026", "07", "30");
	mkdirSync(sessionsDir, { recursive: true });
	writeFileSync(
		join(sessionsDir, `rollout-2026-07-30T00-00-00-${STUB_DISCOVERED_SESSION_ID}.jsonl`),
		`${JSON.stringify({ cwd })}\n`,
		"utf8",
	);
}

const runtimeHome = process.env.KANBAN_RUNTIME_HOME ?? (process.env.HOME ? join(process.env.HOME, ".kanban") : null);
if (runtimeHome) {
	mkdirSync(runtimeHome, { recursive: true });
	const argvPath = join(runtimeHome, `launched-argv-${taskId}.json`);
	writeFileSync(argvPath, JSON.stringify(process.argv), "utf8");

	let stdinBuffer = "";
	if (process.stdin.setRawMode) {
		process.stdin.setRawMode(true);
	}
	process.stdin.resume();
	if (process.stdin.unref) {
		process.stdin.unref();
	}
	process.stdin.on("data", (chunk) => {
		stdinBuffer += chunk.toString("utf8");
		const stdinPath = join(runtimeHome, `launched-stdin-${taskId}.txt`);
		writeFileSync(stdinPath, stdinBuffer, "utf8");
	});
}

appendFileSync(markerPath, `stub commit for ${taskId}\n`, "utf8");
run("git", ["add", "stub-agent-output.txt"], { cwd });
run("git", ["commit", "-qm", `stub agent commit for ${taskId}`], { cwd });
if (EARLY_REVIEW_TASK_IDS.has(taskId)) {
	await notifyReview();
}
// Session-id discovery only polls while the session is still live, so a task that
// asserts on it needs the stub to stay up rather than exit in 100ms.
const sleepMs =
	taskId === "selfcheck-restart-after-gone" ||
	DISCOVERABLE_SESSION_TASK_IDS.has(taskId) ||
	taskId.includes("steer") ||
	taskId.startsWith("gemini-test")
		? 60000
		: 100;
await new Promise((resolve) => setTimeout(resolve, sleepMs));
if (!EARLY_REVIEW_TASK_IDS.has(taskId)) {
	await notifyReview();
}
process.stdout.write("stub-agent: committed deterministic work\n");
