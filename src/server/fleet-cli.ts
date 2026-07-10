// Bridge to the `fleet` control-tower CLI (Architect Steering, Phase A).
//
// The architect drives the board through the `fleet` CLI, and `fleet help
// --agent` prints a curated, instruction-style tool list that is the source of
// truth for what the overseer can do. We run it and inject its stdout into the
// architect's prompt rather than hardcoding the text, so the wiring stays in
// lockstep with the CLI.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// A hung or runaway CLI must never block starting the agent, so cap time and
// output. The help text is small; a megabyte is comfortably generous.
const FLEET_HELP_TIMEOUT_MS = 5_000;
const FLEET_HELP_MAX_BUFFER_BYTES = 1024 * 1024;

/** The fleet tool instructions resolved successfully. */
export interface FleetAgentHelpSuccess {
	ok: true;
	instructions: string;
}

/**
 * Resolving the fleet tools failed. `error` is a short, user-facing reason so
 * the architect session can tell the user its board tools are unavailable.
 */
export interface FleetAgentHelpFailure {
	ok: false;
	error: string;
}

export type FleetAgentHelpResult = FleetAgentHelpSuccess | FleetAgentHelpFailure;

/**
 * Turn a raw exec failure into a short reason the user can act on, without
 * leaking a stack trace into the prompt/toast.
 */
function describeFleetError(error: unknown): string {
	const candidate = error as { code?: string | number | null; killed?: boolean; stderr?: unknown; message?: unknown };
	if (candidate?.code === "ENOENT") {
		return "the fleet CLI was not found on PATH";
	}
	if (candidate?.killed) {
		return "the fleet CLI timed out";
	}
	const stderr = String(candidate?.stderr ?? "").trim();
	if (stderr) {
		return stderr.split("\n")[0];
	}
	const message = String(candidate?.message ?? "").trim();
	return message || "the fleet CLI could not be run";
}

/**
 * Run `fleet help --agent` and return its curated tool instructions.
 *
 * The board inherits the user's shell env, so `fleet` resolves on PATH. This
 * never throws: any failure (missing binary, non-zero exit, timeout, empty
 * output) comes back as `{ ok: false, error }` so callers can both degrade to a
 * fleet-less prompt AND surface the reason to the user.
 *
 * `binary`/`args` default to `fleet help --agent`; they are overridable so the
 * exec + failure paths can be exercised hermetically in tests.
 */
export async function runFleetAgentHelp(
	cwd: string,
	binary = "fleet",
	args: string[] = ["help", "--agent"],
): Promise<FleetAgentHelpResult> {
	try {
		const { stdout } = await execFileAsync(binary, args, {
			cwd,
			encoding: "utf8",
			timeout: FLEET_HELP_TIMEOUT_MS,
			maxBuffer: FLEET_HELP_MAX_BUFFER_BYTES,
		});
		const trimmed = String(stdout ?? "").trim();
		if (!trimmed) {
			return { ok: false, error: "`fleet help --agent` produced no output" };
		}
		return { ok: true, instructions: trimmed };
	} catch (error) {
		return { ok: false, error: describeFleetError(error) };
	}
}
