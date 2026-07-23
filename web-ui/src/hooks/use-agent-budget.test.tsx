import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeAgentBudgetResponse } from "@/runtime/types";
import { AGENT_BUDGET_POLL_INTERVAL_MS, useAgentBudget } from "./use-agent-budget";

const fetchAgentBudgetMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/runtime-config-query", () => ({
	fetchAgentBudget: fetchAgentBudgetMock,
}));

const mockBudget: RuntimeAgentBudgetResponse = {
	available: true,
	generatedAt: 12345678,
	providers: [
		{
			provider: "claude",
			plan: "max",
			staleSeconds: 0,
			worstRemainingPercent: 55,
			windows: [],
		},
	],
};

describe("useAgentBudget", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		fetchAgentBudgetMock.mockReset();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.useRealTimers();
		vi.restoreAllMocks();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
			return;
		}
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	async function renderHook() {
		let hookResult: ReturnType<typeof useAgentBudget> | null = null;

		function HookHarness(): null {
			hookResult = useAgentBudget();
			return null;
		}

		await act(async () => {
			root.render(<HookHarness />);
			await Promise.resolve();
			await Promise.resolve();
		});

		return {
			getState: () => {
				if (!hookResult) {
					throw new Error("Hook state not available");
				}
				return hookResult;
			},
		};
	}

	it("asserts the poll interval is 15 minutes", () => {
		expect(AGENT_BUDGET_POLL_INTERVAL_MS).toBe(15 * 60 * 1000);
	});

	it("given the hook is rendered, when mounted, then it performs an initial fetch", async () => {
		fetchAgentBudgetMock.mockResolvedValue(mockBudget);

		const { getState } = await renderHook();

		expect(fetchAgentBudgetMock).toHaveBeenCalledTimes(1);
		expect(getState().data).toEqual(mockBudget);
	});

	it("given the hook is rendered, when the 15-minute interval fires, then it refetches the budget", async () => {
		vi.useFakeTimers();
		fetchAgentBudgetMock.mockResolvedValue(mockBudget);

		await renderHook();
		expect(fetchAgentBudgetMock).toHaveBeenCalledTimes(1);

		// Advance timers by 15 minutes
		await act(async () => {
			await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
			await Promise.resolve();
		});

		expect(fetchAgentBudgetMock).toHaveBeenCalledTimes(2);
	});
});
