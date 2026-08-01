import { DRIVERS, supported, unsupported } from "../../../src/agents/driver";
import { getAggregatedBudget, resetAgentBudgetCacheForTests } from "../../../src/server/agent-budget";
import { assertOk } from "../scenario-api";

export async function givenAgentBudgetWhenAProviderCannotBeReadThenTheReadoutSaysUnknownNotZero(): Promise<void> {
	// Preserve original drivers
	const originalClaudeRead = DRIVERS.claude.budget.read;
	const originalCodexRead = DRIVERS.codex.budget.read;

	try {
		resetAgentBudgetCacheForTests();

		// Case 1: Provider returns null/absent utilization for a window.
		// The INVARIANT is that its remainingPercent MUST render as null (unknown), never as a number (like 0 or 100).
		DRIVERS.claude.budget.read = async () =>
			supported({
				plan: "max",
				staleSeconds: 0,
				windows: [
					{ name: "5h", remainingPercent: null, resetsAt: null }, // Null/absent utilization
					{ name: "week", remainingPercent: 40.0, resetsAt: null },
				],
			});

		DRIVERS.codex.budget.read = async () =>
			supported({
				plan: "plus",
				staleSeconds: 0,
				windows: [{ name: "5h", remainingPercent: 75.0, resetsAt: null }],
			});

		const report = await getAggregatedBudget();

		const claude = report.providers.find((p) => p.provider === "claude");
		assertOk(claude !== undefined, "Claude provider should be present in the report.");

		const h5Window = claude?.windows?.find((w) => w.name === "5h");
		assertOk(h5Window !== undefined, "Claude 5h window should be present.");
		assertOk(
			h5Window?.remainingPercent === null,
			`Invariant Violation: Claude 5h window with null utilization rendered as ${String(h5Window?.remainingPercent)} instead of null (unknown).`,
		);

		// Case 2: One provider fails (unsupported / throws).
		// The INVARIANT is that this must NOT empty the report for the other functioning providers.
		DRIVERS.claude.budget.read = async () => unsupported("Claude API offline");

		const reportWithError = await getAggregatedBudget();

		const claudeWithError = reportWithError.providers.find((p) => p.provider === "claude");
		assertOk(claudeWithError !== undefined, "Claude provider with error should still exist in report.");
		assertOk(claudeWithError?.error === "Claude API offline", "Claude provider error should be captured.");

		const codex = reportWithError.providers.find((p) => p.provider === "codex");
		assertOk(
			codex !== undefined,
			"Other functioning providers (Codex) must still be returned in the report when another provider errors.",
		);
		assertOk(codex?.windows?.[0]?.remainingPercent === 75.0, "Codex budget numbers must be intact.");
	} finally {
		// Restore original drivers
		DRIVERS.claude.budget.read = originalClaudeRead;
		DRIVERS.codex.budget.read = originalCodexRead;
		resetAgentBudgetCacheForTests();
	}
}
