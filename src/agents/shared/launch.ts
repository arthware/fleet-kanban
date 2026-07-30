import { getRuntimeAgentBinaryCandidates } from "../../core/agent-catalog";
import type { RuntimeAgentId } from "../../core/api-contract";
import { isBinaryAvailableOnPath } from "../../terminal/command-discovery";

export function hasCliOption(args: readonly string[], optionName: string): boolean {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === optionName || arg.startsWith(`${optionName}=`)) {
			return true;
		}
	}
	return false;
}

export function withPrompt(
	args: readonly string[],
	prompt: string,
	mode: "append" | "flag",
	flag?: string,
): readonly string[] {
	const trimmed = prompt.trim();
	if (!trimmed) {
		return args;
	}
	const result = [...args];
	if (mode === "flag" && flag) {
		result.push(flag, trimmed);
	} else {
		result.push(trimmed);
	}
	return result;
}

/**
 * Shared preflight check for agent drivers.
 *
 * Precedence of test hooks:
 * 1. KANBAN_TEST_PREFLIGHT_FAIL: explicitly fail preflight with a custom message.
 * 2. KANBAN_TEST_AGENT_BINARY: integration test stub agent path, bypasses path checks.
 * 3. KANBAN_TEST_PREFLIGHT_REAL: force executing the real path checks even during Vitest unit tests.
 */
export async function binaryPreflight(
	agentId: RuntimeAgentId,
): Promise<
	| { readonly supported: true; readonly value: { readonly ok: true } }
	| { readonly supported: false; readonly reason: string }
> {
	const testFail = process.env.KANBAN_TEST_PREFLIGHT_FAIL;
	if (testFail) {
		return { supported: false, reason: testFail };
	}
	const isTest =
		(typeof process.env.VITEST !== "undefined" && !process.env.KANBAN_TEST_PREFLIGHT_REAL) ||
		typeof process.env.KANBAN_TEST_AGENT_BINARY !== "undefined";
	if (!isTest) {
		const candidates = getRuntimeAgentBinaryCandidates(agentId);
		const binary = candidates.find((candidate) => isBinaryAvailableOnPath(candidate));
		if (!binary) {
			return { supported: false, reason: `binary missing: '${agentId}' CLI binary not found on PATH` };
		}
		if (process.env.KANBAN_WORKSPACE_TRUST === "untrusted") {
			return { supported: false, reason: "not trusted: workspace is not trusted" };
		}
	}
	return { supported: true, value: { ok: true as const } };
}
