import { describe, expect, it } from "vitest";

import type { RuntimeBoardData } from "../../src/core/api-contract";
import {
	addTaskDependency,
	addTaskToColumn,
	completeTaskAndGetReadyLinkedTaskIds,
	deleteTasksFromBoard,
	moveTaskToColumn,
	trashTaskAndGetReadyLinkedTaskIds,
	updateTask,
} from "../../src/core/task-board-mutations";

function createBoard(): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "done", title: "Done", cards: [] },
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies: [],
	};
}

describe("done/trash lifecycle mutations", () => {
	it("moves a review task to done and returns ready linked backlog task ids", () => {
		const createBacklog = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Dependent task", baseRef: "main" },
			() => "aaaaa111",
		);
		const createReview = addTaskToColumn(
			createBacklog.board,
			"review",
			{ prompt: "Prerequisite task", baseRef: "main" },
			() => "bbbbb111",
		);
		const linked = addTaskDependency(createReview.board, "aaaaa", "bbbbb");
		expect(linked.added).toBe(true);

		const completed = completeTaskAndGetReadyLinkedTaskIds(linked.board, "bbbbb", 123);

		expect(completed.moved).toBe(true);
		expect(completed.readyTaskIds).toEqual(["aaaaa"]);
		expect(completed.board.columns.find((column) => column.id === "done")?.cards.map((card) => card.id)).toEqual([
			"bbbbb",
		]);
		expect(completed.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
	});

	it("moves a review task to trash without returning ready linked backlog task ids", () => {
		const createBacklog = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Dependent task", baseRef: "main" },
			() => "aaaaa111",
		);
		const createReview = addTaskToColumn(
			createBacklog.board,
			"review",
			{ prompt: "Prerequisite task", baseRef: "main" },
			() => "bbbbb111",
		);
		const linked = addTaskDependency(createReview.board, "aaaaa", "bbbbb");
		expect(linked.added).toBe(true);

		const trashed = trashTaskAndGetReadyLinkedTaskIds(linked.board, "bbbbb", 123);

		expect(trashed.moved).toBe(true);
		expect(trashed.readyTaskIds).toEqual([]);
		expect(trashed.board.columns.find((column) => column.id === "trash")?.cards.map((card) => card.id)).toEqual([
			"bbbbb",
		]);
	});

	it("rejects creating a new dependency to a done task", () => {
		const createBacklog = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Dependent task", baseRef: "main" },
			() => "aaaaa111",
		);
		const createDone = addTaskToColumn(
			createBacklog.board,
			"done",
			{ prompt: "Finished task", baseRef: "main" },
			() => "bbbbb111",
		);

		const linked = addTaskDependency(createDone.board, "aaaaa", "bbbbb");

		expect(linked.added).toBe(false);
		expect(linked.reason).toBe("terminal_task");
	});

	it("prunes dependencies when a linked task moves to done", () => {
		const createBacklog = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Dependent task", baseRef: "main" },
			() => "aaaaa111",
		);
		const createReview = addTaskToColumn(
			createBacklog.board,
			"review",
			{ prompt: "Prerequisite task", baseRef: "main" },
			() => "bbbbb111",
		);
		const linked = addTaskDependency(createReview.board, "aaaaa", "bbbbb");
		expect(linked.board.dependencies).toHaveLength(1);

		const completed = completeTaskAndGetReadyLinkedTaskIds(linked.board, "bbbbb");

		expect(completed.board.dependencies).toEqual([]);
	});
});

describe("deleteTasksFromBoard", () => {
	it("removes a trashed task and any dependencies that reference it", () => {
		const createA = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task A", baseRef: "main" },
			() => "aaaaa111",
		);
		const createB = addTaskToColumn(createA.board, "review", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");
		const linked = addTaskDependency(createB.board, "aaaaa", "bbbbb");
		if (!linked.added) {
			throw new Error("Expected dependency to be created.");
		}
		const trashed = trashTaskAndGetReadyLinkedTaskIds(linked.board, "bbbbb");
		const deleted = deleteTasksFromBoard(trashed.board, ["bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds).toEqual(["bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
		expect(deleted.board.dependencies).toEqual([]);
	});

	it("removes multiple trashed tasks at once", () => {
		const createA = addTaskToColumn(createBoard(), "trash", { prompt: "Task A", baseRef: "main" }, () => "aaaaa111");
		const createB = addTaskToColumn(createA.board, "trash", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");

		const deleted = deleteTasksFromBoard(createB.board, ["aaaaa", "bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds.sort()).toEqual(["aaaaa", "bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
	});
});

describe("task images", () => {
	it("preserves images when creating and updating tasks", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task with image",
				baseRef: "main",
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
			},
			() => "aaaaa111",
		);

		expect(created.task.images).toEqual([
			{
				id: "img-1",
				data: "abc123",
				mimeType: "image/png",
			},
		]);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task with updated image",
			baseRef: "main",
			images: [
				{
					id: "img-2",
					data: "def456",
					mimeType: "image/jpeg",
				},
			],
		});

		expect(updated.task?.images).toEqual([
			{
				id: "img-2",
				data: "def456",
				mimeType: "image/jpeg",
			},
		]);
	});
});

describe("per-task agent/model/provider overrides", () => {
	it("persists agentId on the card when creating a task", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Smart task", baseRef: "main", agentId: "claude" },
			() => "aaaaa111",
		);

		expect(created.task.agentId).toBe("claude");
	});

	it("persists task-level Cline settings on the card when creating a task", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Dumb task",
				baseRef: "main",
				agentId: "cline",
				clineSettings: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-20250514",
					reasoningEffort: "high",
				},
			},
			() => "aaaaa111",
		);

		expect(created.task.agentId).toBe("cline");
		expect(created.task.clineSettings).toEqual({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-20250514",
			reasoningEffort: "high",
		});
	});

	it("leaves override fields undefined when not provided", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Default task", baseRef: "main" },
			() => "aaaaa111",
		);

		expect(created.task.agentId).toBeUndefined();
		expect(created.task.clineSettings).toBeUndefined();
	});

	it("persists a per-card agent model on the card when creating a task", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Mechanical task", baseRef: "main", agentId: "claude", agentModel: "claude-haiku-4-5" },
			() => "aaaaa111",
		);

		expect(created.task.agentModel).toBe("claude-haiku-4-5");
	});

	it("leaves the agent model undefined when not provided", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Default-model task", baseRef: "main" },
			() => "aaaaa111",
		);

		expect(created.task.agentModel).toBeUndefined();
	});

	it("updates agentId from undefined to a value", () => {
		const created = addTaskToColumn(createBoard(), "backlog", { prompt: "Task", baseRef: "main" }, () => "aaaaa111");
		expect(created.task.agentId).toBeUndefined();

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			agentId: "codex",
		});

		expect(updated.updated).toBe(true);
		expect(updated.task?.agentId).toBe("codex");
	});

	it("updates clineModelId", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", clineSettings: { modelId: "old-model" } },
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			clineSettings: { modelId: "new-model" },
		});

		expect(updated.task?.clineSettings?.modelId).toBe("new-model");
	});

	it("preserves existing overrides when update input omits them (undefined)", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task",
				baseRef: "main",
				agentId: "claude",
				clineSettings: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-20250514",
					reasoningEffort: "low",
				},
			},
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Updated prompt",
			baseRef: "main",
			// agentId and clineSettings are undefined, so existing overrides should persist
		});

		expect(updated.task?.agentId).toBe("claude");
		expect(updated.task?.clineSettings).toEqual({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-20250514",
			reasoningEffort: "low",
		});
	});

	it("clears overrides when update input provides null", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task",
				baseRef: "main",
				agentId: "codex",
				clineSettings: {
					providerId: "openai",
					modelId: "gpt-4",
					reasoningEffort: "medium",
				},
			},
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			agentId: null,
			clineSettings: null,
		});

		expect(updated.task?.agentId).toBeUndefined();
		expect(updated.task?.clineSettings).toBeUndefined();
	});

	it("updates agentModel from undefined to a value", () => {
		const created = addTaskToColumn(createBoard(), "backlog", { prompt: "Task", baseRef: "main" }, () => "aaaaa111");
		expect(created.task.agentModel).toBeUndefined();

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			agentModel: "claude-haiku-4-5",
		});

		expect(updated.updated).toBe(true);
		expect(updated.task?.agentModel).toBe("claude-haiku-4-5");
	});

	it("preserves agentModel when update input omits it (undefined)", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", agentModel: "claude-haiku-4-5" },
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Updated prompt",
			baseRef: "main",
			// agentModel is undefined, so the existing override should persist
		});

		expect(updated.task?.agentModel).toBe("claude-haiku-4-5");
	});

	it("clears agentModel when update input provides null", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", agentModel: "claude-haiku-4-5" },
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			agentModel: null,
		});

		expect(updated.task?.agentModel).toBeUndefined();
	});

	it("preserves agentModel across move operations", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Movable task", baseRef: "main", agentModel: "claude-haiku-4-5" },
			() => "aaaaa111",
		);

		const moved = moveTaskToColumn(created.board, created.task.id, "in_progress");

		expect(moved.moved).toBe(true);
		expect(moved.task?.agentModel).toBe("claude-haiku-4-5");
	});

	it("preserves overrides across move operations", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Movable task",
				baseRef: "main",
				agentId: "claude",
				clineSettings: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-20250514",
					reasoningEffort: "high",
				},
			},
			() => "aaaaa111",
		);

		const moved = moveTaskToColumn(created.board, created.task.id, "in_progress");

		expect(moved.moved).toBe(true);
		expect(moved.task?.agentId).toBe("claude");
		expect(moved.task?.clineSettings).toEqual({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-20250514",
			reasoningEffort: "high",
		});
	});
});

describe("external issue metadata", () => {
	const externalIssue = {
		provider: "github" as const,
		key: "owner/repo#42",
		url: "https://github.com/owner/repo/issues/42",
		raw: "owner/repo#42",
	};

	it("persists externalIssue on the card when creating a task", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Issue-backed task", baseRef: "main", externalIssue },
			() => "aaaaa111",
		);

		expect(created.task.externalIssue).toEqual(externalIssue);
	});

	it("updates externalIssue from undefined to a value", () => {
		const created = addTaskToColumn(createBoard(), "backlog", { prompt: "Task", baseRef: "main" }, () => "aaaaa111");

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			externalIssue,
		});

		expect(updated.updated).toBe(true);
		expect(updated.task?.externalIssue).toEqual(externalIssue);
	});

	it("preserves externalIssue when update input omits it", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", externalIssue },
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Updated prompt",
			baseRef: "main",
		});

		expect(updated.task?.externalIssue).toEqual(externalIssue);
	});

	it("clears externalIssue when update input provides null", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", externalIssue },
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			externalIssue: null,
		});

		expect(updated.task?.externalIssue).toBeUndefined();
	});

	it("preserves externalIssue across move operations", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Movable task", baseRef: "main", externalIssue },
			() => "aaaaa111",
		);

		const moved = moveTaskToColumn(created.board, created.task.id, "review");

		expect(moved.moved).toBe(true);
		expect(moved.task?.externalIssue).toEqual(externalIssue);
	});
});
