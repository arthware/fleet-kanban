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
				gateStatus: "none",
			},
			"task-2-ship-another-feature": {
				url: "https://github.com/cline/kanban/pull/43",
				state: "closed",
				number: 43,
				gateStatus: "none",
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
				gateStatus: "none",
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

	it("derives gateStatus as 'none' when statusCheckRollup is empty or missing", () => {
		const result = selectRepoCardPrsByHead(
			JSON.stringify([
				{
					headRefName: "task-1-ship-a-feature",
					url: "https://github.com/cline/kanban/pull/42",
					state: "OPEN",
					number: 42,
					statusCheckRollup: [],
				},
			]),
		);

		expect(Object.fromEntries(result)["task-1-ship-a-feature"]?.gateStatus).toBe("none");
	});

	it("derives gateStatus as 'failing' when there is a failing check or error context", () => {
		const result = selectRepoCardPrsByHead(
			JSON.stringify([
				{
					headRefName: "task-1-ship-a-feature",
					url: "https://github.com/cline/kanban/pull/42",
					state: "OPEN",
					number: 42,
					statusCheckRollup: [
						{ status: "COMPLETED", conclusion: "SUCCESS" },
						{ status: "COMPLETED", conclusion: "FAILURE" },
					],
				},
			]),
		);

		expect(Object.fromEntries(result)["task-1-ship-a-feature"]?.gateStatus).toBe("failing");
	});

	it("derives gateStatus as 'pending' when there is an in-progress or queued check", () => {
		const result = selectRepoCardPrsByHead(
			JSON.stringify([
				{
					headRefName: "task-1-ship-a-feature",
					url: "https://github.com/cline/kanban/pull/42",
					state: "OPEN",
					number: 42,
					statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }],
				},
			]),
		);

		expect(Object.fromEntries(result)["task-1-ship-a-feature"]?.gateStatus).toBe("pending");
	});

	it("derives gateStatus as 'pending' when there is a PENDING StatusContext", () => {
		const result = selectRepoCardPrsByHead(
			JSON.stringify([
				{
					headRefName: "task-1-ship-a-feature",
					url: "https://github.com/cline/kanban/pull/42",
					state: "OPEN",
					number: 42,
					statusCheckRollup: [{ state: "PENDING" }],
				},
			]),
		);

		expect(Object.fromEntries(result)["task-1-ship-a-feature"]?.gateStatus).toBe("pending");
	});

	it("derives gateStatus as 'passing' when all checks are completed success, skipped, or neutral", () => {
		const result = selectRepoCardPrsByHead(
			JSON.stringify([
				{
					headRefName: "task-1-ship-a-feature",
					url: "https://github.com/cline/kanban/pull/42",
					state: "OPEN",
					number: 42,
					statusCheckRollup: [
						{ status: "COMPLETED", conclusion: "SUCCESS" },
						{ status: "COMPLETED", conclusion: "SKIPPED" },
						{ state: "SUCCESS" },
					],
				},
			]),
		);

		expect(Object.fromEntries(result)["task-1-ship-a-feature"]?.gateStatus).toBe("passing");
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
				gateStatus: "none",
			},
		});
		expect(calls).toEqual([
			{
				args: [
					"pr",
					"list",
					"--state",
					"all",
					"--limit",
					"200",
					"--json",
					"headRefName,url,state,number,statusCheckRollup",
				],
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
