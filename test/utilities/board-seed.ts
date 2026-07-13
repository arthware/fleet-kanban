import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	type RuntimeBoardCard,
	type RuntimeBoardColumnId,
	type RuntimeBoardData,
	type RuntimeTaskSessionSummary,
	runtimeBoardDataSchema,
} from "../../src/core/api-contract";

const BOARD_COLUMNS: Array<{ id: RuntimeBoardColumnId; title: string }> = [
	{ id: "backlog", title: "Backlog" },
	{ id: "in_progress", title: "In Progress" },
	{ id: "review", title: "Review" },
	{ id: "done", title: "Done" },
	{ id: "trash", title: "Trash" },
];

export const STUB_LIFECYCLE_TASK_ID = "stub-lifecycle";
export const LINKED_PARENT_TASK_ID = "linked-parent";
export const LINKED_CHILD_TASK_ID = "linked-child";

function now(): number {
	return 1_700_000_000_000;
}

function createCard(input: {
	id: string;
	title: string;
	prompt: string;
	baseRef?: string;
	externalIssueKey?: string;
}): RuntimeBoardCard {
	const timestamp = now();
	return {
		id: input.id,
		title: input.title,
		prompt: input.prompt,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		agentId: "droid",
		baseRef: input.baseRef ?? "main",
		createdAt: timestamp,
		updatedAt: timestamp,
		transitions: [{ column: "backlog", at: timestamp }],
		...(input.externalIssueKey
			? {
					externalIssue: {
						provider: "linear" as const,
						key: input.externalIssueKey,
						raw: input.externalIssueKey,
					},
				}
			: {}),
	};
}

export function createStubLifecycleBoard(): RuntimeBoardData {
	const board: RuntimeBoardData = {
		columns: BOARD_COLUMNS.map((column) => ({
			...column,
			cards:
				column.id === "backlog"
					? [
							createCard({
								id: STUB_LIFECYCLE_TASK_ID,
								title: "Stub lifecycle",
								prompt: "Make a deterministic stub-agent commit.",
								externalIssueKey: "ENG-123",
							}),
							createCard({
								id: LINKED_PARENT_TASK_ID,
								title: "Linked parent",
								prompt: "Parent task unblocks the child.",
							}),
							createCard({
								id: LINKED_CHILD_TASK_ID,
								title: "Linked child",
								prompt: "Child task auto-starts after the parent is done.",
							}),
						]
					: [],
		})),
		dependencies: [
			{
				id: "dep-linked-child-parent",
				fromTaskId: LINKED_CHILD_TASK_ID,
				toTaskId: LINKED_PARENT_TASK_ID,
				createdAt: now(),
			},
		],
	};
	return runtimeBoardDataSchema.parse(board);
}

export interface SeedBoardStateInput {
	homeDir: string;
	workspaceId: string;
	board?: RuntimeBoardData;
	sessions?: Record<string, RuntimeTaskSessionSummary>;
	revision?: number;
}

export function seedIsolatedBoardState(input: SeedBoardStateInput): RuntimeBoardData {
	const board = runtimeBoardDataSchema.parse(input.board ?? createStubLifecycleBoard());
	const workspaceDir = join(input.homeDir, ".cline", "kanban", "workspaces", input.workspaceId);
	mkdirSync(workspaceDir, { recursive: true });
	writeFileSync(join(workspaceDir, "board.json"), `${JSON.stringify(board, null, 2)}\n`);
	writeFileSync(join(workspaceDir, "sessions.json"), `${JSON.stringify(input.sessions ?? {}, null, 2)}\n`);
	writeFileSync(
		join(workspaceDir, "meta.json"),
		`${JSON.stringify({ revision: input.revision ?? 1, updatedAt: now() }, null, 2)}\n`,
	);
	return board;
}
