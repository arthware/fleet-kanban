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
const sleepMs = (taskId === "selfcheck-restart-after-gone" || taskId.includes("steer")) ? 60000 : 100;
await new Promise((resolve) => setTimeout(resolve, sleepMs));
await notifyReview();
process.stdout.write("stub-agent: committed deterministic work\n");
