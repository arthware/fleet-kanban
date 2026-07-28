import { describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData } from "../../../src/core/api-contract";
import {
	type EnsureAutoReviewPrCommandResult,
	type EnsureAutoReviewPrGhRunner,
	type EnsureAutoReviewPrGitRunner,
	type EnsureAutoReviewPrInput,
	type EnsureAutoReviewPrResult,
	ensureAutoReviewPr,
	ensureAutoReviewPrForReview,
} from "../../../src/server/ensure-auto-review-pr";

interface RecordedCall {
	tool: "git" | "gh";
	args: string[];
}

function makeRunners(opts: {
	push?: EnsureAutoReviewPrCommandResult;
	gh?: (args: string[]) => EnsureAutoReviewPrCommandResult;
}): {
	calls: RecordedCall[];
	runGit: EnsureAutoReviewPrGitRunner;
	runGh: EnsureAutoReviewPrGhRunner;
} {
	const calls: RecordedCall[] = [];
	const runGit: EnsureAutoReviewPrGitRunner = async (_cwd, args) => {
		calls.push({ tool: "git", args });
		return opts.push ?? { ok: true, stdout: "", stderr: "" };
	};
	const runGh: EnsureAutoReviewPrGhRunner = async (_cwd, args) => {
		calls.push({ tool: "gh", args });
		return opts.gh ? opts.gh(args) : { ok: true, stdout: "[]", stderr: "" };
	};
	return { calls, runGit, runGh };
}

function baseInput(overrides: Partial<EnsureAutoReviewPrInput> = {}): EnsureAutoReviewPrInput {
	return {
		cwd: "/tmp/worktree",
		taskId: "abcde",
		branch: "abcde-my-card",
		baseRef: "production-line",
		title: "My card",
		body: "commit subject\n\ncommit body",
		...overrides,
	};
}

describe("ensureAutoReviewPr", () => {
	it("given an open PR already exists, when ensuring, then it does not create a new PR", async () => {
		// given
		const { calls, runGit, runGh } = makeRunners({
			gh: (args) =>
				args[1] === "list"
					? { ok: true, stdout: JSON.stringify([{ url: "https://github.com/o/r/pull/7", number: 7 }]), stderr: "" }
					: { ok: true, stdout: "", stderr: "" },
		});

		// when
		const result = await ensureAutoReviewPr(baseInput({ runGit, runGh }));

		// then
		expect(result.outcome).toBe("exists");
		expect(result.prUrl).toBe("https://github.com/o/r/pull/7");
		expect(calls.some((c) => c.tool === "gh" && c.args[1] === "create")).toBe(false);
	});

	it("given an open PR already exists for the card branch on another base, when ensuring, then it fails loudly instead of creating a duplicate", async () => {
		// given
		const { calls, runGit, runGh } = makeRunners({
			gh: (args) =>
				args[1] === "list"
					? {
							ok: true,
							stdout: JSON.stringify([
								{
									url: "https://github.com/o/r/pull/7",
									number: 7,
									baseRefName: "main",
								},
							]),
							stderr: "",
						}
					: { ok: true, stdout: "", stderr: "" },
		});

		// when
		const result = await ensureAutoReviewPr(baseInput({ runGit, runGh }));

		// then
		expect(result.outcome).toBe("base_mismatch");
		expect(result.prUrl).toBe("https://github.com/o/r/pull/7");
		expect(result.detail).toContain("main");
		expect(result.detail).toContain("production-line");
		expect(calls.some((c) => c.tool === "gh" && c.args[1] === "create")).toBe(false);
	});

	it("given the base ref is missing, when ensuring, then it fails before gh can default to the repository base branch", async () => {
		// given
		const { calls, runGit, runGh } = makeRunners({});

		// when
		const result = await ensureAutoReviewPr(baseInput({ baseRef: "  ", runGit, runGh }));

		// then
		expect(result.outcome).toBe("base_ref_missing");
		expect(result.detail).toContain("baseRef");
		expect(calls).toEqual([]);
	});

	it("given no PR exists, when ensuring, then it creates one non-interactive PR against the base ref", async () => {
		// given
		const { calls, runGit, runGh } = makeRunners({
			gh: (args) =>
				args[1] === "create"
					? { ok: true, stdout: "https://github.com/o/r/pull/12\n", stderr: "" }
					: { ok: true, stdout: "[]", stderr: "" },
		});

		// when
		const result = await ensureAutoReviewPr(baseInput({ runGit, runGh }));

		// then
		expect(result.outcome).toBe("created");
		expect(result.prUrl).toBe("https://github.com/o/r/pull/12");
		const createCall = calls.find((c) => c.tool === "gh" && c.args[1] === "create");
		expect(createCall?.args).toEqual([
			"pr",
			"create",
			"--base",
			"production-line",
			"--head",
			"abcde-my-card",
			"--title",
			"My card",
			"--body",
			"commit subject\n\ncommit body",
		]);
	});

	it("given the gh list runner fails, when ensuring, then it resolves without throwing and creates nothing", async () => {
		// given
		const { calls, runGit, runGh } = makeRunners({
			gh: (args) =>
				args[1] === "list"
					? { ok: false, stdout: "", stderr: "gh: auth error" }
					: { ok: true, stdout: "", stderr: "" },
		});

		// when
		const result = await ensureAutoReviewPr(baseInput({ runGit, runGh }));

		// then
		expect(result.outcome).toBe("list_failed");
		expect(calls.some((c) => c.tool === "gh" && c.args[1] === "create")).toBe(false);
	});

	it("given the push fails and no PR exists, when ensuring, then it reports push_failed and creates nothing", async () => {
		// given
		const { calls, runGit, runGh } = makeRunners({
			push: { ok: false, stdout: "", stderr: "fatal: no upstream" },
		});

		// when
		const result = await ensureAutoReviewPr(baseInput({ runGit, runGh }));

		// then
		expect(result.outcome).toBe("push_failed");
		expect(calls.some((c) => c.tool === "gh" && c.args[1] === "create")).toBe(false);
	});

	it("when ensuring, then the branch is pushed before the PR is checked", async () => {
		// given
		const { calls, runGit, runGh } = makeRunners({});

		// when
		await ensureAutoReviewPr(baseInput({ runGit, runGh }));

		// then
		expect(calls[0]).toEqual({ tool: "git", args: ["push", "origin", "abcde-my-card"] });
		expect(calls[1]?.tool).toBe("gh");
		expect(calls[1]?.args[1]).toBe("list");
	});

	it("given the create runner fails, when ensuring, then it resolves as create_failed", async () => {
		// given
		const { runGit, runGh } = makeRunners({
			gh: (args) =>
				args[1] === "create"
					? { ok: false, stdout: "", stderr: "gh: create failed" }
					: { ok: true, stdout: "[]", stderr: "" },
		});

		// when
		const result = await ensureAutoReviewPr(baseInput({ runGit, runGh }));

		// then
		expect(result.outcome).toBe("create_failed");
	});
});

function boardWithCard(overrides: Record<string, unknown> = {}): RuntimeBoardData {
	return {
		columns: [
			{
				id: "in_progress",
				title: "In Progress",
				cards: [
					{
						id: "abcde",
						title: "My card",
						prompt: "Do the thing",
						startInPlanMode: false,
						baseRef: "production-line",
						autoReviewEnabled: true,
						autoReviewMode: "pr",
						createdAt: 1,
						updatedAt: 1,
						...overrides,
					},
				],
			},
		],
		dependencies: [],
	} as unknown as RuntimeBoardData;
}

describe("ensureAutoReviewPrForReview", () => {
	it("given an auto-PR card, when ensuring for review, then it calls ensure with the card's branch, base ref and title", async () => {
		// given
		const ensure = vi.fn(
			async (_input: EnsureAutoReviewPrInput): Promise<EnsureAutoReviewPrResult> => ({
				outcome: "created",
				branch: "abcde-my-card",
				prUrl: "https://github.com/o/r/pull/1",
			}),
		);

		// when
		await ensureAutoReviewPrForReview({
			workspaceId: "ws-1",
			taskId: "abcde",
			cwd: "/tmp/worktree",
			loadBoard: async () => boardWithCard(),
			resolveGhEnv: async () => ({ GH_REPO: "o/r", GH_PROMPT_DISABLED: "1" }),
			runGit: async () => ({ ok: true, stdout: "commit subject\n\ncommit body", stderr: "" }),
			ensure,
		});

		// then
		expect(ensure).toHaveBeenCalledTimes(1);
		const input = ensure.mock.calls[0][0];
		expect(input.branch).toBe("abcde-my-card");
		expect(input.baseRef).toBe("production-line");
		expect(input.title).toBe("My card");
		expect(input.body).toBe("commit subject\n\ncommit body");
		expect(input.gitEnv).toEqual({ GH_REPO: "o/r", GH_PROMPT_DISABLED: "1" });
	});

	it("given a non-auto-review card, when ensuring for review, then the ensure step is not invoked", async () => {
		// given
		const ensure = vi.fn();

		// when
		const result = await ensureAutoReviewPrForReview({
			workspaceId: "ws-1",
			taskId: "abcde",
			cwd: "/tmp/worktree",
			loadBoard: async () => boardWithCard({ autoReviewEnabled: false, autoReviewMode: undefined }),
			ensure,
		});

		// then
		expect(ensure).not.toHaveBeenCalled();
		expect(result).toBeNull();
	});

	it("given the card is absent from the board, when ensuring for review, then it no-ops", async () => {
		// given
		const ensure = vi.fn();

		// when
		const result = await ensureAutoReviewPrForReview({
			workspaceId: "ws-1",
			taskId: "missing",
			cwd: "/tmp/worktree",
			loadBoard: async () => boardWithCard(),
			ensure,
		});

		// then
		expect(ensure).not.toHaveBeenCalled();
		expect(result).toBeNull();
	});
});
