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
});
