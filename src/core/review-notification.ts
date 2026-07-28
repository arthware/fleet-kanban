import type { RuntimeBoardCard, RuntimeTaskSessionSummary } from "./api-contract";
import { createHomeAgentSessionId, isHomeAgentSessionIdForWorkspace } from "./home-agent-session";
import { resolveTaskTitle } from "./task-title";

const REVIEW_NOTIFICATION_KEY_PREFIX = "review";

export function buildTaskReadyForReviewMessage(task: RuntimeBoardCard): string {
	const title = resolveTaskTitle(task.title, task.prompt);
	return `Card ${task.id} ("${title}") was moved to review and is awaiting your review.`;
}

export function buildTaskReviewNotificationKey(input: {
	taskId: string;
	summary: RuntimeTaskSessionSummary | null | undefined;
}): string {
	const checkpointTurn = input.summary?.latestTurnCheckpoint?.turn;
	if (checkpointTurn !== undefined) {
		return `${REVIEW_NOTIFICATION_KEY_PREFIX}:${input.taskId}:turn-${checkpointTurn}`;
	}
	const reason = input.summary?.reviewReason ?? "unknown";
	return `${REVIEW_NOTIFICATION_KEY_PREFIX}:${input.taskId}:${reason}`;
}

export function hasReviewNotificationBeenSent(input: {
	taskId: string;
	summary: RuntimeTaskSessionSummary | null | undefined;
}): boolean {
	const summary = input.summary;
	return summary?.lastReviewNotificationKey === buildTaskReviewNotificationKey(input);
}

export function resolveRunningHomeAgentTaskId(input: {
	architectWorkspaceId: string;
	taskId: string;
	summaries: RuntimeTaskSessionSummary[];
	isAttached: (summary: RuntimeTaskSessionSummary) => boolean;
}): string | null {
	if (isHomeAgentSessionIdForWorkspace(input.taskId, input.architectWorkspaceId)) {
		return null;
	}
	const architectHomeAgentTaskId = createHomeAgentSessionId(input.architectWorkspaceId);
	const homeAgentSummary = input.summaries.find((summary) => summary.taskId === architectHomeAgentTaskId);
	if (!homeAgentSummary || !input.isAttached(homeAgentSummary)) {
		return null;
	}
	return architectHomeAgentTaskId;
}
