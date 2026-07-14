import { describe, expect, it } from "vitest";

import { type GhRunner, resolveCardPrUrl, selectCardPrUrl } from "../../../src/workspace/card-pr-url";

const openPrJson = JSON.stringify([
	{
		url: "https://github.com/cline/kanban/pull/42",
		state: "OPEN",
		number: 42,
		title: "Add card PR lookup",
	},
]);

describe("selectCardPrUrl", () => {
	it("prefers an open PR over a merged PR", () => {
		const result = selectCardPrUrl(
			JSON.stringify([
				{
					url: "https://github.com/cline/kanban/pull/41",
					state: "MERGED",
					number: 41,
					title: "Earlier merged work",
				},
				{
					url: "https://github.com/cline/kanban/pull/42",
					state: "OPEN",
					number: 42,
					title: "Current open work",
				},
			]),
		);

		expect(result).toEqual({
			url: "https://github.com/cline/kanban/pull/42",
			state: "open",
			number: 42,
		});
	});

	it("returns the merged PR when only merged PRs are present", () => {
		const result = selectCardPrUrl(
			JSON.stringify([
				{
					url: "https://github.com/cline/kanban/pull/40",
					state: "MERGED",
					number: 40,
					title: "Saved card work",
				},
			]),
		);

		expect(result).toEqual({
			url: "https://github.com/cline/kanban/pull/40",
			state: "merged",
			number: 40,
		});
	});

	it("selects the highest-numbered merged PR when multiple merged PRs are present", () => {
		const result = selectCardPrUrl(
			JSON.stringify([
				{
					url: "https://github.com/cline/kanban/pull/39",
					state: "MERGED",
					number: 39,
					title: "First merged work",
				},
				{
					url: "https://github.com/cline/kanban/pull/44",
					state: "MERGED",
					number: 44,
					title: "Most recent merged work",
				},
			]),
		);

		expect(result).toEqual({
			url: "https://github.com/cline/kanban/pull/44",
			state: "merged",
			number: 44,
		});
	});

	it("given a PR list with only a closed-unmerged PR, when selectCardPrUrl runs, then it returns that PR with state closed", () => {
		const result = selectCardPrUrl(
			JSON.stringify([
				{
					url: "https://github.com/cline/kanban/pull/43",
					state: "CLOSED",
					number: 43,
					title: "Closed without merge",
				},
			]),
		);

		expect(result).toEqual({
			url: "https://github.com/cline/kanban/pull/43",
			state: "closed",
			number: 43,
		});
	});

	it("selects the highest-numbered terminal PR across merged and closed PRs", () => {
		const result = selectCardPrUrl(
			JSON.stringify([
				{
					url: "https://github.com/cline/kanban/pull/40",
					state: "MERGED",
					number: 40,
					title: "Merged work",
				},
				{
					url: "https://github.com/cline/kanban/pull/45",
					state: "CLOSED",
					number: 45,
					title: "Later closed work",
				},
			]),
		);

		expect(result).toEqual({
			url: "https://github.com/cline/kanban/pull/45",
			state: "closed",
			number: 45,
		});
	});

	it("returns null for an empty array", () => {
		expect(selectCardPrUrl("[]")).toBeNull();
	});

	it("returns null for malformed JSON", () => {
		expect(selectCardPrUrl("{not json")).toBeNull();
	});

	it("returns null when a selected PR is missing its url", () => {
		const result = selectCardPrUrl(
			JSON.stringify([
				{
					state: "OPEN",
					number: 45,
					title: "Missing URL",
				},
			]),
		);

		expect(result).toBeNull();
	});
});

describe("resolveCardPrUrl", () => {
	it("runs gh for the branch and returns the parsed PR ref", async () => {
		const calls: Array<{ args: string[]; cwd: string }> = [];
		const run: GhRunner = async (args, cwd) => {
			calls.push({ args, cwd });
			return openPrJson;
		};

		const result = await resolveCardPrUrl({
			branch: "task/card-pr-url",
			cwd: "/repo",
			run,
		});

		expect(result).toEqual({
			url: "https://github.com/cline/kanban/pull/42",
			state: "open",
			number: 42,
		});
		expect(calls).toEqual([
			{
				args: ["pr", "list", "--head", "task/card-pr-url", "--state", "all", "--json", "url,state,number,title"],
				cwd: "/repo",
			},
		]);
	});

	it("resolves null when gh fails", async () => {
		const run: GhRunner = async () => {
			throw new Error("gh not found");
		};

		await expect(resolveCardPrUrl({ branch: "task/card-pr-url", cwd: "/repo", run })).resolves.toBeNull();
	});
});
