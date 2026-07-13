import { describe, expect, it } from "vitest";

import { resolveCardIdFromRefOrIssue, resolveExternalIssueForTaskCommand } from "../../../src/commands/task";
import type {
	RuntimeBoardCard,
	RuntimeExternalIssueProvider,
	RuntimeWorkspaceStateResponse,
} from "../../../src/core/api-contract";

function createCard(
	id: string,
	externalIssue?: { provider: RuntimeExternalIssueProvider; key: string; raw?: string },
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
