import { describe, expect, it, vi } from "vitest";

import { type GhRunner, listRepoCardPrsByHead, selectRepoCardPrsByHead } from "../../../src/workspace/card-pr-url";

const openPrJson = JSON.stringify([
	{
		url: "https://github.com/cline/kanban/pull/42",
		state: "OPEN",
		number: 42,
		headRefName: "task-1-ship-a-feature",
	},
]);

describe("selectRepoCardPrsByHead", () => {
	it("groups PRs by head branch and prefers an open PR over terminal PRs", () => {
		const result = selectRepoCardPrsByHead(
			JSON.stringify([
				{
					headRefName: "task-1-ship-a-feature",
					url: "https://github.com/cline/kanban/pull/41",
					state: "MERGED",
					number: 41,
				},
				{
					headRefName: "task-1-ship-a-feature",
					url: "https://github.com/cline/kanban/pull/42",
					state: "OPEN",
					number: 42,
				},
				{
					headRefName: "task-2-ship-another-feature",
					url: "https://github.com/cline/kanban/pull/43",
					state: "CLOSED",
					number: 43,
				},
			]),
		);

		expect(Object.fromEntries(result)).toEqual({
			"task-1-ship-a-feature": {
				url: "https://github.com/cline/kanban/pull/42",
				state: "open",
				number: 42,
			},
			"task-2-ship-another-feature": {
				url: "https://github.com/cline/kanban/pull/43",
				state: "closed",
				number: 43,
			},
		});
	});

	it("selects the highest-numbered terminal PR across merged and closed PRs", () => {
		const result = selectRepoCardPrsByHead(
			JSON.stringify([
				{
					headRefName: "task-1-ship-a-feature",
					url: "https://github.com/cline/kanban/pull/40",
					state: "MERGED",
					number: 40,
				},
				{
					headRefName: "task-1-ship-a-feature",
					url: "https://github.com/cline/kanban/pull/45",
					state: "CLOSED",
					number: 45,
				},
			]),
		);

		expect(Object.fromEntries(result)).toEqual({
			"task-1-ship-a-feature": {
				url: "https://github.com/cline/kanban/pull/45",
				state: "closed",
				number: 45,
			},
		});
	});

	it("returns an empty map when a PR item is missing its head branch", () => {
		const result = selectRepoCardPrsByHead(
			JSON.stringify([
				{
					url: "https://github.com/cline/kanban/pull/42",
					state: "OPEN",
					number: 42,
				},
			]),
		);

		expect(result.size).toBe(0);
	});

	it("returns an empty map for malformed repo PR JSON", () => {
		expect(selectRepoCardPrsByHead("{not json").size).toBe(0);
	});
});

describe("listRepoCardPrsByHead", () => {
	it("runs one repo-wide gh list and returns PRs keyed by head branch", async () => {
		const calls: Array<{ args: string[]; cwd: string }> = [];
		const run: GhRunner = async (args, cwd) => {
			calls.push({ args, cwd });
			return JSON.stringify([
				{
					headRefName: "task-1-ship-a-feature",
					url: "https://github.com/cline/kanban/pull/42",
					state: "OPEN",
					number: 42,
				},
			]);
		};

		const result = await listRepoCardPrsByHead({
			cwd: "/repo",
			run,
			hasRemote: async () => true,
		});

		expect(Object.fromEntries(result)).toEqual({
			"task-1-ship-a-feature": {
				url: "https://github.com/cline/kanban/pull/42",
				state: "open",
				number: 42,
			},
		});
		expect(calls).toEqual([
			{
				args: ["pr", "list", "--state", "all", "--limit", "200", "--json", "headRefName,url,state,number"],
				cwd: "/repo",
			},
		]);
	});

	it("given no git remote exists, when listing repo PRs, then it does not invoke gh", async () => {
		const run = vi.fn<GhRunner>(async () => openPrJson);

		const result = await listRepoCardPrsByHead({
			cwd: "/repo",
			run,
			hasRemote: async () => false,
		});

		expect(result.size).toBe(0);
		expect(run).not.toHaveBeenCalled();
	});

	it("resolves an empty map when gh is unavailable or unauthenticated", async () => {
		const run: GhRunner = async () => {
			throw new Error("gh auth required");
		};

		await expect(
			listRepoCardPrsByHead({
				cwd: "/repo",
				run,
				hasRemote: async () => true,
			}),
		).resolves.toEqual(new Map());
	});
});
