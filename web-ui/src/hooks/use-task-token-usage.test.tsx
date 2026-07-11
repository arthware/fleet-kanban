import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mergeTaskTokenUsage, type TaskTokenUsageById, useTaskTokenUsage } from "@/hooks/use-task-token-usage";
import type { RuntimeTaskTokenUsage } from "@/runtime/types";

const getTaskTokenUsageQueryMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		runtime: {
			getTaskTokenUsage: {
				query: getTaskTokenUsageQueryMock,
			},
		},
	}),
}));

function usage(overrides?: Partial<RuntimeTaskTokenUsage>): RuntimeTaskTokenUsage {
	return {
		inputTokens: 1000,
		outputTokens: 200,
		cacheReadTokens: 50,
		cacheCreationTokens: 10,
		costUsd: null,
		...overrides,
	};
}

describe("mergeTaskTokenUsage", () => {
	it("keeps a known value when a later batch reports it absent", () => {
		const cached: TaskTokenUsageById = { a: usage() };

		const merged = mergeTaskTokenUsage(cached, { a: null });

		expect(merged.a).toBe(cached.a);
	});

	it("adopts a fresh value over the cached one", () => {
		const next = usage({ inputTokens: 9000 });

		const merged = mergeTaskTokenUsage({ a: usage() }, { a: next });

		expect(merged.a).toBe(next);
	});

	it("records a first-seen absent id as null", () => {
		const merged = mergeTaskTokenUsage({}, { a: null });

		expect(merged).toHaveProperty("a", null);
	});

	it("returns the same reference when nothing changed", () => {
		const cached: TaskTokenUsageById = { a: usage() };

		expect(mergeTaskTokenUsage(cached, { a: null })).toBe(cached);
	});
});

describe("useTaskTokenUsage", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		getTaskTokenUsageQueryMock.mockReset();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function Harness({
		taskIds,
		isPolling,
		onSnapshot,
	}: {
		taskIds: string[];
		isPolling: boolean;
		onSnapshot: (value: TaskTokenUsageById) => void;
	}): null {
		const value = useTaskTokenUsage({ currentProjectId: "project-1", taskIds, isPolling });
		useEffect(() => {
			onSnapshot(value);
		}, [onSnapshot, value]);
		return null;
	}

	it("batches every visible card id into one request", async () => {
		getTaskTokenUsageQueryMock.mockResolvedValue({ ok: true, usage: { a: usage(), b: null } });
		const snapshots: TaskTokenUsageById[] = [];

		await act(async () => {
			root.render(<Harness taskIds={["a", "b"]} isPolling={false} onSnapshot={(v) => snapshots.push(v)} />);
		});

		expect(getTaskTokenUsageQueryMock).toHaveBeenCalledTimes(1);
		expect(getTaskTokenUsageQueryMock).toHaveBeenCalledWith({ taskIds: ["a", "b"] });
		expect(snapshots.at(-1)?.a).toBeTruthy();
	});

	it("caches the last value across a poll that returns absent", async () => {
		vi.useFakeTimers();
		const firstUsage = usage();
		getTaskTokenUsageQueryMock
			.mockResolvedValueOnce({ ok: true, usage: { a: firstUsage } })
			.mockResolvedValue({ ok: true, usage: { a: null } });
		const snapshots: TaskTokenUsageById[] = [];

		try {
			await act(async () => {
				root.render(<Harness taskIds={["a"]} isPolling onSnapshot={(v) => snapshots.push(v)} />);
			});
			expect(snapshots.at(-1)?.a).toBe(firstUsage);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(4000);
			});

			expect(getTaskTokenUsageQueryMock.mock.calls.length).toBeGreaterThan(1);
			expect(snapshots.at(-1)?.a).toBe(firstUsage);
		} finally {
			vi.useRealTimers();
		}
	});
});
