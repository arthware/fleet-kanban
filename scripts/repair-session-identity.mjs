#!/usr/bin/env node
/**
 * One-shot repair for card session identity, for boards that ran before the
 * agent-switch fix.
 *
 * Two drifts accumulated:
 *
 * 1. A session id discovered after spawn was written to `sessions.json` but never
 *    back into the card's ledger manifest, which is stamped once at session open —
 *    when a discovered-id agent has no id yet. The manifest keeps `null` while a
 *    real, often multi-megabyte transcript sits on disk.
 * 2. Switching a card's agent left the previous agent's session id on the card, so
 *    `sessions.json` pairs one agent with another's session. That pair can never be
 *    resolved: the transcript resolver looks under the wrong harness.
 *
 * Reports by default; pass `--apply` to write. Writes are atomic (tmp + rename).
 */
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const apply = process.argv.includes("--apply");
const clineHome =
	process.env.CLINE_HOME ?? process.argv.find((a) => a.startsWith("--home="))?.slice(7) ?? join(homedir(), ".cline");
const workspaceId = process.argv.find((a) => a.startsWith("--workspace="))?.slice(12) ?? "fleet-kanban";

const workspaceDir = join(clineHome, "kanban", "workspaces", workspaceId);
const sessionsPath = join(workspaceDir, "sessions.json");
const sessionsDir = join(workspaceDir, "sessions");

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJsonAtomic(path, value) {
	const tmp = `${path}.repair-tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

const summaries = readJson(sessionsPath);
const backfilled = [];
const foreign = [];

for (const taskId of readdirSync(sessionsDir)) {
	const taskDir = join(sessionsDir, taskId);
	if (!statSync(taskDir).isDirectory()) continue;
	const summary = summaries[taskId];
	if (!summary) continue;

	for (const generation of readdirSync(taskDir)) {
		const manifestPath = join(taskDir, generation, "manifest.json");
		let manifest;
		try {
			manifest = readJson(manifestPath);
		} catch {
			continue;
		}

		// (1) The ledger never learned the id the runtime discovered.
		if (manifest.agentSessionId === null && summary.agentSessionId && manifest.agentId === summary.agentId) {
			backfilled.push({ taskId, generation, agentId: manifest.agentId, agentSessionId: summary.agentSessionId });
			if (apply) {
				writeJsonAtomic(manifestPath, { ...manifest, agentSessionId: summary.agentSessionId });
			}
		}

		// (2) The card carries an id its own ledger attributes to a different agent.
		if (
			manifest.agentSessionId &&
			manifest.agentSessionId === summary.agentSessionId &&
			manifest.agentId !== summary.agentId
		) {
			foreign.push({
				taskId,
				agentSessionId: summary.agentSessionId,
				mintedBy: manifest.agentId,
				nowRunningAs: summary.agentId,
				state: summary.state,
			});
		}
	}
}

for (const entry of backfilled) {
	console.log(
		`backfill manifest ${entry.taskId}/${entry.generation}: agentSessionId ${entry.agentSessionId} (${entry.agentId})`,
	);
}
for (const entry of foreign) {
	console.log(
		`clear foreign id  ${entry.taskId}: ${entry.agentSessionId} minted by ${entry.mintedBy}, card now on ${entry.nowRunningAs} (${entry.state})`,
	);
}

if (apply && foreign.length > 0) {
	const next = { ...summaries };
	for (const entry of foreign) {
		next[entry.taskId] = { ...next[entry.taskId], agentSessionId: null, agentSessionLifecycle: "gone" };
	}
	writeJsonAtomic(sessionsPath, next);
}

console.log(
	`\n${apply ? "Repaired" : "Would repair"}: ${backfilled.length} manifest(s), ${foreign.length} foreign session id(s).` +
		(apply ? "" : "\nRe-run with --apply to write."),
);
