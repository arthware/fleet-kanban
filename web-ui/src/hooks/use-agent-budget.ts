import { useCallback } from "react";
import { fetchAgentBudget } from "@/runtime/runtime-config-query";
import type { RuntimeAgentBudgetResponse } from "@/runtime/types";
import { type UseTrpcQueryResult, useTrpcQuery } from "@/runtime/use-trpc-query";
import { useInterval } from "@/utils/react-use";

// The operator accepted a 15-minute cadence for this read (see the card): it shells
// out to the fleet CLI server-side and is cached there with the same TTL, so
// polling faster would just re-request the same cached value.
export const AGENT_BUDGET_POLL_INTERVAL_MS = 15 * 60 * 1000;

// Budget is a host-global reading (not per-workspace), so it isn't scoped to any workspaceId.
export function useAgentBudget(): UseTrpcQueryResult<RuntimeAgentBudgetResponse> {
	const query = useTrpcQuery<RuntimeAgentBudgetResponse>({
		enabled: true,
		queryFn: useCallback(() => fetchAgentBudget(null), []),
	});

	useInterval(() => {
		void query.refetch();
	}, AGENT_BUDGET_POLL_INTERVAL_MS);

	return query;
}
