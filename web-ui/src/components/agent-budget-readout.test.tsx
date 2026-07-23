import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentBudgetReadout } from "@/components/agent-budget-readout";
import type { RuntimeAgentBudgetResponse } from "@/runtime/types";

function makeBudget(overrides: Partial<RuntimeAgentBudgetResponse> = {}): RuntimeAgentBudgetResponse {
	return {
		available: true,
		generatedAt: 1_700_000_000,
		providers: [
			{
				provider: "claude",
				plan: "max",
				staleSeconds: 0,
				worstRemainingPercent: 55,
				windows: [{ name: "week", remainingPercent: 55, resetsAt: 1_700_100_000 }],
			},
			{
				provider: "codex",
				plan: "plus",
				staleSeconds: 0,
				worstRemainingPercent: 6,
				windows: [{ name: "week", remainingPercent: 6, resetsAt: 1_700_100_000 }],
			},
			{
				provider: "cursor",
				plan: "pro",
				staleSeconds: 0,
				worstRemainingPercent: 100,
				windows: [{ name: "cycle", remainingPercent: 100, resetsAt: 1_700_100_000 }],
			},
		],
		...overrides,
	};
}

describe("AgentBudgetReadout", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("given providers at 55%, 6%, and 100% remaining, when rendered, then it shows one pill per provider with the right numbers", () => {
		act(() => {
			root.render(<AgentBudgetReadout budget={makeBudget()} />);
		});

		const claudePill = container.querySelector('[data-testid="agent-budget-pill-claude"]');
		const codexPill = container.querySelector('[data-testid="agent-budget-pill-codex"]');
		const cursorPill = container.querySelector('[data-testid="agent-budget-pill-cursor"]');

		expect(claudePill?.textContent).toContain("55%");
		expect(codexPill?.textContent).toContain("6%");
		expect(cursorPill?.textContent).toContain("100%");
	});

	it("given a provider under the critical threshold, when rendered, then its pill carries the critical color class", () => {
		act(() => {
			root.render(<AgentBudgetReadout budget={makeBudget()} />);
		});

		const codexPill = container.querySelector('[data-testid="agent-budget-pill-codex"]');

		expect(codexPill?.className).toContain("text-status-red");
	});

	it("given a healthy provider, when rendered, then its pill carries the healthy color class", () => {
		act(() => {
			root.render(<AgentBudgetReadout budget={makeBudget()} />);
		});

		const cursorPill = container.querySelector('[data-testid="agent-budget-pill-cursor"]');

		expect(cursorPill?.className).toContain("text-status-green");
	});

	it("given the budget is unavailable, when rendered, then it renders nothing instead of an error", () => {
		act(() => {
			root.render(<AgentBudgetReadout budget={{ available: false, generatedAt: null, providers: [] }} />);
		});

		expect(container.querySelector('[data-testid="agent-budget-readout"]')).toBeNull();
		expect(container.textContent).toBe("");
	});

	it("given no budget data has loaded yet, when rendered, then it renders nothing instead of an error", () => {
		act(() => {
			root.render(<AgentBudgetReadout budget={null} />);
		});

		expect(container.querySelector('[data-testid="agent-budget-readout"]')).toBeNull();
	});

	it("given a claude provider with 5h=31% and week=50%, when rendered, then it shows the 5h value and not the week value", () => {
		const budget = makeBudget({
			providers: [
				{
					provider: "claude",
					plan: "max",
					staleSeconds: 0,
					worstRemainingPercent: 50,
					windows: [
						{ name: "5h", remainingPercent: 31, resetsAt: 1_700_100_000 },
						{ name: "week", remainingPercent: 50, resetsAt: 1_700_100_000 },
					],
				},
			],
		});

		act(() => {
			root.render(<AgentBudgetReadout budget={budget} />);
		});

		const claudePill = container.querySelector('[data-testid="agent-budget-pill-claude"]');
		expect(claudePill?.textContent).toContain("31%");
		expect(claudePill?.textContent).not.toContain("50%");
		expect(claudePill?.textContent).not.toContain("wk");
	});

	it("given a claude provider with 5h=31% and week=18%, when rendered, then it shows both the 5h and the week values", () => {
		const budget = makeBudget({
			providers: [
				{
					provider: "claude",
					plan: "max",
					staleSeconds: 0,
					worstRemainingPercent: 18,
					windows: [
						{ name: "5h", remainingPercent: 31, resetsAt: 1_700_100_000 },
						{ name: "week", remainingPercent: 18, resetsAt: 1_700_100_000 },
					],
				},
			],
		});

		act(() => {
			root.render(<AgentBudgetReadout budget={budget} />);
		});

		const claudePill = container.querySelector('[data-testid="agent-budget-pill-claude"]');
		expect(claudePill?.textContent).toContain("31%");
		expect(claudePill?.textContent).toContain("wk 18%");
	});

	it("given a codex provider with 5h and week windows, when rendered, then it remains unchanged and shows the worst remaining percent", () => {
		const budget = makeBudget({
			providers: [
				{
					provider: "codex",
					plan: "plus",
					staleSeconds: 0,
					worstRemainingPercent: 6,
					windows: [
						{ name: "5h", remainingPercent: 31, resetsAt: 1_700_100_000 },
						{ name: "week", remainingPercent: 6, resetsAt: 1_700_100_000 },
					],
				},
			],
		});

		act(() => {
			root.render(<AgentBudgetReadout budget={budget} />);
		});

		const codexPill = container.querySelector('[data-testid="agent-budget-pill-codex"]');
		expect(codexPill?.textContent).toContain("6%");
		expect(codexPill?.textContent).not.toContain("31%");
		expect(codexPill?.textContent).not.toContain("wk");
	});

	it("given a claude provider missing its 5h window, when rendered, then it falls back to worst remaining percent", () => {
		const budget = makeBudget({
			providers: [
				{
					provider: "claude",
					plan: "max",
					staleSeconds: 0,
					worstRemainingPercent: 55,
					windows: [{ name: "week", remainingPercent: 55, resetsAt: 1_700_100_000 }],
				},
			],
		});

		act(() => {
			root.render(<AgentBudgetReadout budget={budget} />);
		});

		const claudePill = container.querySelector('[data-testid="agent-budget-pill-claude"]');
		expect(claudePill?.textContent).toContain("55%");
	});
});
