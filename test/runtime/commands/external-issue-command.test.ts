import { describe, expect, it, vi } from "vitest";

import {
	formatCreatedTaskRecord,
	formatTaskRecord,
	notifyRuntimeWorkspaceStateUpdated,
	renderTaskCommandSuccess,
	resolveCardIdFromRefOrIssue,
	resolveExternalIssueForTaskCommand,
} from "../../../src/commands/task";
import type {
	RuntimeBoardCard,
	RuntimeExternalIssueProvider,
	RuntimeWorkspaceStateResponse,
} from "../../../src/core/api-contract";

function createCard(
	id: string,
	externalIssue?: { provider: RuntimeExternalIssueProvider; key: string; raw?: string },
	overrides?: Partial<RuntimeBoardCard>,
): RuntimeBoardCard {
	return {
		id,
		title: id,
		prompt: `Prompt for ${id}`,
		startInPlanMode: false,
		autoReviewEnabled: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
		...(externalIssue
			? {
					externalIssue: {
						provider: externalIssue.provider,
						key: externalIssue.key,
						raw: externalIssue.raw ?? externalIssue.key,
					},
				}
			: {}),
	};
}

function createState(cards: RuntimeBoardCard[]): RuntimeWorkspaceStateResponse {
	return {
		repoPath: "/tmp/repo",
		statePath: "/tmp/repo/.cline/kanban/board.json",
		taskWorktreesRoot: "/tmp/.cline/worktrees",
		git: {
			currentBranch: "main",
			defaultBranch: "main",
			branches: ["main"],
		},
		board: {
			columns: [
				{ id: "backlog", title: "Backlog", cards },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "done", title: "Done", cards: [] },
				{ id: "trash", title: "Trash", cards: [] },
			],
			dependencies: [],
		},
		sessions: {},
		revision: 1,
	};
}

describe("task command machine output", () => {
	it("given a backlog card created with a title, when task list record is formatted, then each task record includes that title", () => {
		// given
		const card = createCard("task-with-title", undefined, {
			title: "Explicit machine title",
			prompt: "Prompt text that should not be needed to identify the task",
		});
		const state = createState([card]);

		// when
		const record = formatTaskRecord(state, card, "backlog");

		// then
		expect(record.title).toBe("Explicit machine title");
	});

	it("given a card created without --title, when task list record is formatted, then its record includes the prompt-derived title from resolveTaskTitle", () => {
		// given
		const card = createCard("task-without-title", undefined, {
			title: "   ",
			prompt: "Fix the machine-readable task output.\n\nKeep the prompt body available separately.",
		});
		const state = createState([card]);

		// when
		const record = formatTaskRecord(state, card, "backlog");

		// then
		expect(record.title).toBe("Fix the machine-readable task output.");
	});

	it("given a card created without --title, when task create response is formatted, then it surfaces the resolved title", () => {
		// given
		const card = createCard("created-without-title", undefined, {
			title: "   ",
			prompt: "Create a clean task response.\n\nThe prompt remains separate.",
		});

		// when
		const record = formatCreatedTaskRecord(card, "/tmp/repo");

		// then
		expect(record.title).toBe("Create a clean task response.");
	});

	it("given task create --quiet, when a card is created, then stdout is exactly the new task id and nothing else", () => {
		// given
		const payload = {
			ok: true,
			task: {
				id: "abc123",
				prompt: "This prompt must not be printed in quiet mode.",
			},
		};

		// when
		const output = renderTaskCommandSuccess(payload, { quietTaskIdOnly: true });

		// then
		expect(output).toBe("abc123\n");
	});
});

describe("resolveExternalIssueForTaskCommand", () => {
	it("adds a Linear URL when KANBAN_LINEAR_WORKSPACE is configured", async () => {
		await expect(
			resolveExternalIssueForTaskCommand({
				ref: "ENG-123",
				cwd: "/tmp",
				env: { KANBAN_LINEAR_WORKSPACE: "acme" },
			}),
		).resolves.toEqual({
			provider: "linear",
			key: "ENG-123",
			url: "https://linear.app/acme/issue/ENG-123",
			raw: "ENG-123",
		});
	});

	it("keeps a bare Linear key unlinked without KANBAN_LINEAR_WORKSPACE", async () => {
		await expect(
			resolveExternalIssueForTaskCommand({
				ref: "ENG-123",
				cwd: "/tmp",
				env: {},
			}),
		).resolves.toEqual({
			provider: "linear",
			key: "ENG-123",
			raw: "ENG-123",
		});
	});

	it("rejects unrecognized refs", async () => {
		await expect(resolveExternalIssueForTaskCommand({ ref: "not-an-issue", cwd: "/tmp", env: {} })).rejects.toThrow(
			"Invalid external issue reference",
		);
	});
});

describe("resolveCardIdFromRefOrIssue", () => {
	it("keeps a real card id when an external issue key has the same value", () => {
		const state = createState([
			createCard("d0cbc"),
			createCard("ENG-123", { provider: "github", key: "owner/repo#12" }),
			createCard("issue-card", { provider: "linear", key: "ENG-123" }),
		]);

		expect(resolveCardIdFromRefOrIssue(state, "ENG-123")).toBe("ENG-123");
	});

	it.each([
		["ENG-123", "linear-task"],
		["owner/repo#12", "repo-task"],
		["#12", "short-github-task"],
	])("resolves issue key %s to canonical card id %s", (key, expectedId) => {
		const state = createState([
			createCard("linear-task", { provider: "linear", key: "ENG-123" }),
			createCard("repo-task", { provider: "github", key: "owner/repo#12" }),
			createCard("short-github-task", { provider: "github", key: "#12" }),
		]);

		expect(resolveCardIdFromRefOrIssue(state, key)).toBe(expectedId);
	});

	it("rejects ambiguous issue keys", () => {
		const state = createState([
			createCard("first-card", { provider: "linear", key: "ENG-123" }),
			createCard("second-card", { provider: "linear", key: "ENG-123" }),
		]);

		expect(() => resolveCardIdFromRefOrIssue(state, "ENG-123")).toThrow(
			'Multiple cards reference issue "ENG-123": first-card, second-card. Pass the card id instead.',
		);
	});

	it("returns an unknown ref unchanged for the caller's not-found path", () => {
		const state = createState([createCard("d0cbc", { provider: "linear", key: "ENG-123" })]);

		expect(resolveCardIdFromRefOrIssue(state, "missing-task")).toBe("missing-task");
	});
});

describe("notifyRuntimeWorkspaceStateUpdated", () => {
	it("surfaces and logs a failed runtime notify instead of swallowing it", async () => {
		const warn = vi.fn();
		const runtimeClient = {
			workspace: {
				notifyStateUpdated: {
					mutate: vi.fn(async () => {
						throw new Error("notify failed");
					}),
				},
			},
		} as unknown as Parameters<typeof notifyRuntimeWorkspaceStateUpdated>[0];

		await expect(notifyRuntimeWorkspaceStateUpdated(runtimeClient, { warn })).rejects.toThrow("notify failed");
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("notify failed"));
	});
});
