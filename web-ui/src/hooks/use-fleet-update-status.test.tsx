import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeFleetUpdateApplyResult, RuntimeFleetUpdateStatusResponse } from "@/runtime/types";
import { type FleetUpdatePhase, useFleetUpdateStatus } from "./use-fleet-update-status";

const runtimeConfigQueryMocks = vi.hoisted(() => ({
	fetchFleetUpdateStatus: vi.fn<(workspaceId: string | null) => Promise<RuntimeFleetUpdateStatusResponse>>(),
	applyFleetUpdate: vi.fn<(workspaceId: string | null) => Promise<RuntimeFleetUpdateApplyResult>>(),
}));

vi.mock("@/runtime/runtime-config-query", () => ({
	fetchFleetUpdateStatus: runtimeConfigQueryMocks.fetchFleetUpdateStatus,
	applyFleetUpdate: runtimeConfigQueryMocks.applyFleetUpdate,
}));

interface UseFleetUpdateStatusResult {
	status: RuntimeFleetUpdateStatusResponse | null;
	phase: FleetUpdatePhase;
	apply: () => void;
}

const vendorUpToDate: RuntimeFleetUpdateStatusResponse = {
	status: { mode: "vendor", current: "abc1234", latest: "abc1234", updateAvailable: false },
	inProgressCount: 0,
};

const vendorBehind: RuntimeFleetUpdateStatusResponse = {
	status: { mode: "vendor", current: "abc1234", latest: "def5678", updateAvailable: true },
	inProgressCount: 0,
};

const vendorBehindWithCardsInProgress: RuntimeFleetUpdateStatusResponse = {
	status: { mode: "vendor", current: "abc1234", latest: "def5678", updateAvailable: true },
	inProgressCount: 2,
};

describe("useFleetUpdateStatus", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let reloadSpy: ReturnType<typeof vi.fn>;
	let originalLocation: Location;

	beforeEach(() => {
		runtimeConfigQueryMocks.fetchFleetUpdateStatus.mockReset();
		runtimeConfigQueryMocks.applyFleetUpdate.mockReset();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

		originalLocation = window.location;
		reloadSpy = vi.fn();
		Object.defineProperty(window, "location", {
			configurable: true,
			value: { ...originalLocation, reload: reloadSpy },
		});
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.useRealTimers();
		vi.restoreAllMocks();
		Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
			return;
		}
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	async function renderHook(): Promise<{ getState: () => UseFleetUpdateStatusResult }> {
		let hookResult: UseFleetUpdateStatusResult | null = null;

		function HookHarness(): null {
			hookResult = useFleetUpdateStatus();
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

	it("given the runtime reports no update available, when it mounts, then it surfaces that status with an idle phase", async () => {
		runtimeConfigQueryMocks.fetchFleetUpdateStatus.mockResolvedValue(vendorUpToDate);

		const { getState } = await renderHook();

		expect(getState().status).toEqual(vendorUpToDate);
		expect(getState().phase).toBe("idle");
	});

	it("given an update is available, when apply() is called, then it calls applyFleetUpdate and moves to the restarting phase", async () => {
		runtimeConfigQueryMocks.fetchFleetUpdateStatus.mockResolvedValue(vendorBehind);
		runtimeConfigQueryMocks.applyFleetUpdate.mockResolvedValue({ started: true, reason: null });

		const { getState } = await renderHook();

		await act(async () => {
			getState().apply();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(runtimeConfigQueryMocks.applyFleetUpdate).toHaveBeenCalledTimes(1);
		expect(getState().phase).toBe("restarting");
	});

	it("given the server declines to start (cards in progress), when apply() is called, then it stays idle and does not reload", async () => {
		runtimeConfigQueryMocks.fetchFleetUpdateStatus.mockResolvedValue(vendorBehindWithCardsInProgress);
		runtimeConfigQueryMocks.applyFleetUpdate.mockResolvedValue({ started: false, reason: "cards-in-progress" });

		const { getState } = await renderHook();

		await act(async () => {
			getState().apply();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(getState().phase).toBe("idle");
		expect(reloadSpy).not.toHaveBeenCalled();
	});

	it("given the board is restarting, when a status poll finally succeeds again, then it reloads the page", async () => {
		vi.useFakeTimers();
		runtimeConfigQueryMocks.fetchFleetUpdateStatus.mockResolvedValueOnce(vendorBehind);
		runtimeConfigQueryMocks.applyFleetUpdate.mockResolvedValue({ started: true, reason: null });
		runtimeConfigQueryMocks.fetchFleetUpdateStatus.mockRejectedValueOnce(new Error("connection refused"));
		runtimeConfigQueryMocks.fetchFleetUpdateStatus.mockResolvedValueOnce(vendorUpToDate);

		const { getState } = await renderHook();

		await act(async () => {
			getState().apply();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(getState().phase).toBe("restarting");

		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});
		expect(reloadSpy).not.toHaveBeenCalled();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});
		expect(reloadSpy).toHaveBeenCalledTimes(1);
	});

	it("given the board never comes back within the timeout, when polling during restart, then it reports a timed-out phase instead of polling forever", async () => {
		vi.useFakeTimers();
		runtimeConfigQueryMocks.fetchFleetUpdateStatus.mockResolvedValueOnce(vendorBehind);
		runtimeConfigQueryMocks.applyFleetUpdate.mockResolvedValue({ started: true, reason: null });
		runtimeConfigQueryMocks.fetchFleetUpdateStatus.mockRejectedValue(new Error("connection refused"));

		const { getState } = await renderHook();

		await act(async () => {
			getState().apply();
			await Promise.resolve();
			await Promise.resolve();
		});

		await act(async () => {
			await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 5_000);
		});

		expect(getState().phase).toBe("restart-timed-out");
		expect(reloadSpy).not.toHaveBeenCalled();
	});

	it("does not throw when the initial status query rejects", async () => {
		runtimeConfigQueryMocks.fetchFleetUpdateStatus.mockRejectedValue(new Error("offline"));

		const { getState } = await renderHook();

		expect(getState().status).toBeNull();
		expect(getState().phase).toBe("idle");
	});
});
