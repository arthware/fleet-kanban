// Fetches per-card token usage for the currently-rendered board cards.
//
// Usage is DERIVED on read from each agent's own transcript (see
// `src/terminal/agent-usage-reader.ts`), so a fetch is cheap-but-not-free file
// I/O. This hook keeps that cost in check: it batches every visible card id into
// ONE `runtime.getTaskTokenUsage` round-trip, polls on a slow cadence only while
// a session is active (fetching once more when the board goes idle), and caches
// the last value so the chip never flickers empty between polls.
import { useCallback, useEffect, useRef, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeTaskTokenUsage } from "@/runtime/types";
import { useInterval } from "@/utils/react-use";

/** Slow cadence: derive-on-read is cheap per file but not free on a full board. */
const ACTIVE_POLL_INTERVAL_MS = 4000;

export type TaskTokenUsageById = Record<string, RuntimeTaskTokenUsage | null>;

interface UseTaskTokenUsageInput {
	currentProjectId: string | null;
	/** Card ids to fetch usage for — the caller filters to session-bearing cards. */
	taskIds: string[];
	/** Keep polling while any card's session is active; idle boards fetch once. */
	isPolling: boolean;
}

/**
 * Merge a freshly-fetched batch into the cached map. A batch entry that comes
 * back `null` (transcript gone/empty this tick) must NOT overwrite a value we
 * already know — that would flicker the chip empty. A first-seen absent id is
 * recorded as `null` so callers can tell "asked, nothing yet" apart from "never
 * asked". Returns the same reference when nothing changed to avoid re-renders.
 */
export function mergeTaskTokenUsage(current: TaskTokenUsageById, incoming: TaskTokenUsageById): TaskTokenUsageById {
	let next: TaskTokenUsageById | null = null;
	const ensureDraft = (): TaskTokenUsageById => {
		if (!next) {
			next = { ...current };
		}
		return next;
	};
	for (const [taskId, usage] of Object.entries(incoming)) {
		if (usage) {
			if (current[taskId] !== usage) {
				ensureDraft()[taskId] = usage;
			}
		} else if (!(taskId in current)) {
			ensureDraft()[taskId] = null;
		}
		// else: incoming null but we already hold a value → keep the cached value.
	}
	return next ?? current;
}

export function useTaskTokenUsage({
	currentProjectId,
	taskIds,
	isPolling,
}: UseTaskTokenUsageInput): TaskTokenUsageById {
	const [usageById, setUsageById] = useState<TaskTokenUsageById>({});
	// Read the latest ids inside the fetch without rebuilding it every render.
	const taskIdsRef = useRef(taskIds);
	taskIdsRef.current = taskIds;
	// Stable key so the fetch effect only re-runs when the SET of ids changes.
	const taskIdsKey = taskIds.join(",");

	const fetchUsage = useCallback(async () => {
		if (!currentProjectId) {
			return;
		}
		const ids = taskIdsRef.current;
		if (ids.length === 0) {
			return;
		}
		try {
			const payload = await getRuntimeTrpcClient(currentProjectId).runtime.getTaskTokenUsage.query({
				taskIds: ids,
			});
			if (!payload.ok) {
				return;
			}
			setUsageById((current) => mergeTaskTokenUsage(current, payload.usage));
		} catch {
			// Tolerate a failed poll; keep the last cached values.
		}
	}, [currentProjectId]);

	// Fetch once whenever the project, the id set, or the active state changes —
	// so a board going idle still captures one final total, and a board waking up
	// refreshes immediately instead of waiting a full interval.
	useEffect(() => {
		void fetchUsage();
	}, [fetchUsage, taskIdsKey, isPolling]);

	useInterval(
		() => {
			void fetchUsage();
		},
		isPolling && currentProjectId ? ACTIVE_POLL_INTERVAL_MS : null,
	);

	return usageById;
}
