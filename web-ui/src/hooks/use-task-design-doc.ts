import { useCallback } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeDesignDocResponse } from "@/runtime/types";
import { type UseTrpcQueryResult, useTrpcQuery } from "@/runtime/use-trpc-query";
import type { BoardCard } from "@/types";

export type TaskDesignDocCard = Pick<BoardCard, "id" | "externalIssue">;

// Single source of truth for "does this card have a design doc, and where is it".
// It reuses the server-side `getDesignDoc` resolver (matching `docs/design/<ref>-<slug>.md`
// against the card's external-issue ref then its id) so the design badge and the
// review-column "Implement here" action agree on the doc's existence and resolved
// path — neither re-derives it. Disabled until a workspace is known, and skippable
// via `enabled` so a consumer that already holds a preloaded result never re-fetches.
export function useTaskDesignDoc({
	card,
	workspaceId,
	workspacePath,
	enabled = true,
}: {
	card: TaskDesignDocCard;
	workspaceId: string | null;
	workspacePath?: string | null;
	enabled?: boolean;
}): UseTrpcQueryResult<RuntimeDesignDocResponse> {
	const externalIssueKey = card.externalIssue?.key;
	return useTrpcQuery<RuntimeDesignDocResponse>({
		enabled: enabled && Boolean(workspaceId && workspacePath),
		queryFn: useCallback(async () => {
			const trpc = getRuntimeTrpcClient(workspaceId);
			return await trpc.workspace.getDesignDoc.query({
				taskId: card.id,
				...(externalIssueKey ? { externalIssueKey } : {}),
			});
		}, [card.id, externalIssueKey, workspaceId]),
	});
}
