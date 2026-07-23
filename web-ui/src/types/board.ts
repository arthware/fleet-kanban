import type {
	RuntimeAgentId,
	RuntimeBoardColumnId,
	RuntimeBoardTransition,
	RuntimeCardPrGateStatus,
	RuntimeCardPrState,
	RuntimeExternalIssue,
	RuntimeTaskAutoReviewMode,
	RuntimeTaskClineSettings,
	RuntimeTaskImage,
} from "@/runtime/types";

export type BoardColumnId = RuntimeBoardColumnId;
export type BoardTransition = RuntimeBoardTransition;
export type CardPrState = RuntimeCardPrState;
export type CardPrGateStatus = RuntimeCardPrGateStatus;
export type ExternalIssue = RuntimeExternalIssue;

export type TaskAutoReviewMode = RuntimeTaskAutoReviewMode;
export type TaskImage = RuntimeTaskImage;

export const DEFAULT_TASK_AUTO_REVIEW_MODE: TaskAutoReviewMode = "pr";

export function resolveTaskAutoReviewMode(
	mode: TaskAutoReviewMode | string | null | undefined,
): TaskAutoReviewMode | undefined {
	if (mode === "pr") {
		return mode;
	}
	return undefined;
}

export function getTaskAutoReviewActionLabel(mode: TaskAutoReviewMode | string | null | undefined): string {
	const resolvedMode = resolveTaskAutoReviewMode(mode);
	if (resolvedMode === "pr") {
		return "PR";
	}
	return "manual review";
}

export function getTaskAutoReviewCancelButtonLabel(mode: TaskAutoReviewMode | string | null | undefined): string {
	const resolvedMode = resolveTaskAutoReviewMode(mode);
	if (resolvedMode === "pr") {
		return "Cancel Auto-PR";
	}
	return "Cancel auto-review";
}

export interface BoardCard {
	id: string;
	title: string;
	prompt: string;
	startInPlanMode: boolean;
	autoReviewEnabled: boolean;
	autoReviewMode?: TaskAutoReviewMode;
	images?: TaskImage[];
	agentId?: RuntimeAgentId;
	agentModel?: string;
	skill?: string;
	clineSettings?: RuntimeTaskClineSettings;
	baseRef: string;
	createdAt: number;
	updatedAt: number;
	// The GitHub PR this card's branch led to, captured once at detection so the
	// board can link to it without querying gh at render time. See runtime
	// runtimeBoardCardSchema.
	prUrl?: string;
	prState?: CardPrState;
	prNumber?: number;
	prGateStatus?: CardPrGateStatus;
	externalIssue?: ExternalIssue;
	transitions?: BoardTransition[];
}

export interface BoardColumn {
	id: BoardColumnId;
	title: string;
	cards: BoardCard[];
}

export interface BoardDependency {
	id: string;
	fromTaskId: string;
	toTaskId: string;
	createdAt: number;
}

export interface BoardData {
	columns: BoardColumn[];
	dependencies: BoardDependency[];
}

export interface ReviewTaskWorkspaceSnapshot {
	taskId: string;
	path: string;
	branch: string | null;
	isDetached: boolean;
	headCommit: string | null;
	changedFiles: number | null;
	additions: number | null;
	deletions: number | null;
}

export interface CardSelection {
	card: BoardCard;
	column: BoardColumn;
	allColumns: BoardColumn[];
}
