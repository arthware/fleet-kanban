import { beforeEach, describe, expect, it } from "vitest";
import { DRIVERS, supported, unsupported } from "../../../src/agents/driver";
import { getAgentBudget, getAggregatedBudget, resetAgentBudgetCacheForTests } from "../../../src/server/agent-budget";

describe("Agent Budget Aggregator & Drivers", () => {
	const originalClaudeRead = DRIVERS.claude.budget.read;
	const originalCodexRead = DRIVERS.codex.budget.read;
	const originalGeminiRead = DRIVERS.gemini.budget.read;

	beforeEach(() => {
		resetAgentBudgetCacheForTests();
		DRIVERS.claude.budget.read = originalClaudeRead;
		DRIVERS.codex.budget.read = originalCodexRead;
		DRIVERS.gemini.budget.read = originalGeminiRead;
	});

	it("given mock drivers returning valid budgets, when aggregated, then it normalizes and returns them correctly", async () => {
		DRIVERS.claude.budget.read = async () =>
			supported({
				plan: "max",
				staleSeconds: 0,
				windows: [
					{ name: "5h", remainingPercent: 68.0, resetsAt: 1785573600 },
					{ name: "week", remainingPercent: 40.0, resetsAt: 1785583600 },
				],
			});

		DRIVERS.codex.budget.read = async () =>
			supported({
				plan: "plus",
				staleSeconds: 3600,
				windows: [{ name: "5h", remainingPercent: 79.0, resetsAt: 1785573600 }],
			});

		const report = await getAggregatedBudget();

		const claude = report.providers.find((p) => p.provider === "claude");
		expect(claude).toBeDefined();
		expect(claude?.plan).toBe("max");
		expect(claude?.worstRemainingPercent).toBe(40.0);
		expect(claude?.windows).toHaveLength(2);

		const codex = report.providers.find((p) => p.provider === "codex");
		expect(codex).toBeDefined();
		expect(codex?.plan).toBe("plus");
		expect(codex?.worstRemainingPercent).toBe(79.0);
		expect(codex?.staleSeconds).toBe(3600);
	});

	it("given a driver budget window with null or missing remainingPercent, when computed, then worstRemainingPercent is correct and does not throw", async () => {
		DRIVERS.claude.budget.read = async () =>
			supported({
				plan: "pro",
				staleSeconds: 0,
				windows: [
					{ name: "5h", remainingPercent: null, resetsAt: null },
					{ name: "week", remainingPercent: 12.5, resetsAt: 1785583600 },
				],
			});

		const report = await getAggregatedBudget();
		const claude = report.providers.find((p) => p.provider === "claude");
		expect(claude?.worstRemainingPercent).toBe(12.5);
	});

	it("given one driver throws or is unsupported, when aggregated, then other drivers still succeed and the error is captured", async () => {
		DRIVERS.claude.budget.read = async () => {
			throw new Error("api offline");
		};

		DRIVERS.codex.budget.read = async () =>
			supported({
				plan: "plus",
				staleSeconds: 120,
				windows: [{ name: "5h", remainingPercent: 90.0, resetsAt: null }],
			});

		const report = await getAggregatedBudget();

		const claude = report.providers.find((p) => p.provider === "claude");
		expect(claude).toBeDefined();
		expect(claude?.error).toContain("api offline");

		const codex = report.providers.find((p) => p.provider === "codex");
		expect(codex?.worstRemainingPercent).toBe(90.0);
	});

	it("given getAgentBudget is called on the server, then it filters out errored/empty providers and returns camelCase", async () => {
		DRIVERS.claude.budget.read = async () =>
			supported({
				plan: "max",
				staleSeconds: 0,
				windows: [{ name: "5h", remainingPercent: 68.0, resetsAt: null }],
			});

		DRIVERS.codex.budget.read = async () => unsupported("no sessions found");

		const response = await getAgentBudget();
		expect(response.available).toBe(true);
		expect(response.providers).toHaveLength(1);
		expect(response.providers[0].provider).toBe("claude");
		expect(response.providers[0].worstRemainingPercent).toBe(68.0);
	});

	it("given a cold cache, when getAgentBudget is called concurrently, then it shares the in-flight promise and resolves identically", async () => {
		let callCount = 0;
		DRIVERS.claude.budget.read = async () => {
			callCount += 1;
			return supported({
				plan: "pro",
				staleSeconds: 0,
				windows: [{ name: "5h", remainingPercent: 50.0, resetsAt: null }],
			});
		};

		const [r1, r2] = await Promise.all([getAgentBudget(), getAgentBudget()]);

		expect(callCount).toBe(1);
		expect(r1).toEqual(r2);
		expect(r1.providers[0]?.worstRemainingPercent).toBe(50.0);
	});
});
