import type { RuntimeBoardCard, RuntimeTaskSessionSummary } from "./api-contract";
import { isHomeAgentSessionIdForWorkspace } from "./home-agent-session";
import { resolveTaskTitle } from "./task-title";

export function buildTaskReadyForReviewMessage(task: RuntimeBoardCard): string {
	const title = resolveTaskTitle(task.title, task.prompt);
	return `Card ${task.id} ("${title}") was moved to review and is awaiting your review.`;
}

export function resolveRunningHomeAgentTaskId(input: {
	workspaceId: string;
	taskId: string;
	summaries: RuntimeTaskSessionSummary[];
	isActive: (taskId: string, summary: RuntimeTaskSessionSummary) => boolean;
}): string | null {
	if (isHomeAgentSessionIdForWorkspace(input.taskId, input.workspaceId)) {
		return null;
	}
	const homeAgentSummary = input.summaries.find(
		(summary) =>
			summary.taskId !== input.taskId &&
			isHomeAgentSessionIdForWorkspace(summary.taskId, input.workspaceId) &&
			input.isActive(summary.taskId, summary),
	);
	return homeAgentSummary?.taskId ?? null;
}
