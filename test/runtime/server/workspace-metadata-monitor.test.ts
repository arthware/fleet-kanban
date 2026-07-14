import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardColumnId, RuntimeBoardData } from "../../../src/core/api-contract";
import { runtimeBoardCardSchema } from "../../../src/core/api-contract";
import type { CardPrRef } from "../../../src/workspace/card-pr-url";

// The monitor probes real git state for each tracked task workspace. Stub those
// seams so a tracked card looks like a pushed worktree with a branch, letting the
// PR-capture logic run without touching the filesystem or spawning git.
vi.mock("../../../src/workspace/task-worktree", () => ({
	getTaskWorkspacePathInfo: vi.fn(async ({ taskId }: { taskId: string }) => ({
		taskId,
		path: `/worktrees/${taskId}`,
		exists: true,
		baseRef: "main",
	})),
}));

vi.mock("../../../src/workspace/git-sync", () => ({
	probeGitWorkspaceState: vi.fn(async (cwd: string) => ({
		repoRoot: cwd,
		headCommit: "abc1234",
		currentBranch: "feature/task-1",
		upstreamBranch: "origin/feature/task-1",
		aheadCount: 0,
		behindCount: 0,
		changedFiles: 2,
		untrackedPaths: [],
		stateToken: `${cwd}:token`,
	})),
	getGitSyncSummary: vi.fn(async () => ({
		currentBranch: "feature/task-1",
		upstreamBranch: "origin/feature/task-1",
		changedFiles: 2,
		additions: 5,
		deletions: 1,
		aheadCount: 0,
		behindCount: 0,
	})),
}));

import {
	createWorkspaceMetadataMonitor,
	PR_STATE_REFRESH_MIN_MS,
} from "../../../src/server/workspace-metadata-monitor";

const PR: CardPrRef = {
	url: "https://github.com/cline/kanban/pull/42",
	state: "open",
	number: 42,
};
const MERGED_PR: CardPrRef = {
	...PR,
	state: "merged",
};

function boardWith(columnId: RuntimeBoardColumnId, cardOverrides?: Record<string, unknown>): RuntimeBoardData {
	return {
		columns: [
			{
				id: columnId,
				title: columnId,
				cards: [
					runtimeBoardCardSchema.parse({
						id: "task-1",
						prompt: "Ship a feature",
						startInPlanMode: false,
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
						...cardOverrides,
					}),
				],
			},
		],
		dependencies: [],
	};
}

describe("workspace metadata monitor PR capture", () => {
	let resolveCardPr: ReturnType<typeof vi.fn>;
	let persistCardPr: ReturnType<typeof vi.fn>;
	let monitor: ReturnType<typeof createWorkspaceMetadataMonitor>;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-13T12:00:00.000Z"));
		resolveCardPr = vi.fn(async () => PR);
		persistCardPr = vi.fn(async () => {});
		monitor = createWorkspaceMetadataMonitor({
			onMetadataUpdated: () => {},
			resolveCardPr: resolveCardPr as unknown as (input: {
				branch: string;
				cwd: string;
			}) => Promise<CardPrRef | null>,
			persistCardPr: persistCardPr as unknown as (capture: {
				workspaceId: string;
				workspacePath: string;
				taskId: string;
				pr: CardPrRef;
			}) => Promise<void>,
		});
	});

	afterEach(() => {
		monitor.close();
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("given a card is moved Review to Done before any capture ran, when the transition is processed, then its PR is captured idempotently", async () => {
		// given
		await monitor.updateWorkspaceState({
			workspaceId: "ws-1",
			workspacePath: "/repo",
			board: boardWith("review"),
		});

		// when
		await monitor.updateWorkspaceState({
			workspaceId: "ws-1",
			workspacePath: "/repo",
			board: boardWith("done"),
		});

		// then
		expect(resolveCardPr).toHaveBeenCalledWith({ branch: "feature/task-1", cwd: "/worktrees/task-1" });
		expect(persistCardPr).toHaveBeenCalledTimes(1);
		expect(persistCardPr).toHaveBeenCalledWith({
			workspaceId: "ws-1",
			workspacePath: "/repo",
			taskId: "task-1",
			pr: PR,
		});
	});

	it("given a card whose PR is already stored, when capture runs again, then it does not re-resolve", async () => {
		// given
		await monitor.updateWorkspaceState({
			workspaceId: "ws-1",
			workspacePath: "/repo",
			board: boardWith("review", { prUrl: PR.url, prState: "merged", prNumber: 42 }),
		});

		// when
		await Promise.resolve();

		// then
		expect(resolveCardPr).not.toHaveBeenCalled();
		expect(persistCardPr).not.toHaveBeenCalled();
	});

	it("given a subscribed Review card whose branch led to one, when the metadata refresh runs, then it captures and persists the PR", async () => {
		// given
		await monitor.connectWorkspace({
			workspaceId: "ws-1",
			workspacePath: "/repo",
			board: boardWith("review"),
		});

		// when
		await Promise.resolve();

		// then
		expect(resolveCardPr).toHaveBeenCalledWith({ branch: "feature/task-1", cwd: "/worktrees/task-1" });
		expect(persistCardPr).toHaveBeenCalledTimes(1);
		expect(persistCardPr).toHaveBeenCalledWith({
			workspaceId: "ws-1",
			workspacePath: "/repo",
			taskId: "task-1",
			pr: PR,
		});
	});

	it("given a stored open PR that has since merged, when the monitor re-polls past the refresh interval, then the card's prState becomes merged", async () => {
		// given
		resolveCardPr.mockResolvedValue(PR);
		await monitor.connectWorkspace({
			workspaceId: "ws-1",
			workspacePath: "/repo",
			board: boardWith("review", { prUrl: PR.url, prState: "open", prNumber: 42 }),
		});
		resolveCardPr.mockClear();
		persistCardPr.mockClear();
		resolveCardPr.mockResolvedValue(MERGED_PR);

		// when
		await vi.advanceTimersByTimeAsync(PR_STATE_REFRESH_MIN_MS);

		// then
		expect(resolveCardPr).toHaveBeenCalledWith({ branch: "feature/task-1", cwd: "/worktrees/task-1" });
		expect(persistCardPr).toHaveBeenCalledWith({
			workspaceId: "ws-1",
			workspacePath: "/repo",
			taskId: "task-1",
			pr: MERGED_PR,
		});
	});

	it.each(["merged", "closed"] as const)(
		"given a card whose prState is already terminal (%s), when the monitor polls, then it does not re-run gh for that card",
		async (prState) => {
			// given
			await monitor.connectWorkspace({
				workspaceId: "ws-1",
				workspacePath: "/repo",
				board: boardWith("review", { prUrl: PR.url, prState, prNumber: 42 }),
			});

			// when
			await vi.advanceTimersByTimeAsync(PR_STATE_REFRESH_MIN_MS);

			// then
			expect(resolveCardPr).not.toHaveBeenCalled();
			expect(persistCardPr).not.toHaveBeenCalled();
		},
	);

	it("given a card checked less than PR_STATE_REFRESH_MIN_MS ago, when the monitor polls, then it is skipped", async () => {
		// given
		await monitor.connectWorkspace({
			workspaceId: "ws-1",
			workspacePath: "/repo",
			board: boardWith("review", { prUrl: PR.url, prState: "open", prNumber: 42 }),
		});
		resolveCardPr.mockClear();
		persistCardPr.mockClear();

		// when
		await vi.advanceTimersByTimeAsync(PR_STATE_REFRESH_MIN_MS - 1);

		// then
		expect(resolveCardPr).not.toHaveBeenCalled();
		expect(persistCardPr).not.toHaveBeenCalled();
	});

	it("given no PR exists yet, when the metadata refresh runs, then the card is left unset", async () => {
		// given
		resolveCardPr.mockResolvedValue(null);

		// when
		await monitor.connectWorkspace({
			workspaceId: "ws-1",
			workspacePath: "/repo",
			board: boardWith("review"),
		});

		// then
		expect(resolveCardPr).toHaveBeenCalledTimes(1);
		expect(persistCardPr).not.toHaveBeenCalled();
	});

	it("given an in-progress card, when the metadata refresh runs, then no PR is resolved", async () => {
		// given
		await monitor.connectWorkspace({
			workspaceId: "ws-1",
			workspacePath: "/repo",
			board: boardWith("in_progress"),
		});

		// when
		await Promise.resolve();

		// then
		expect(resolveCardPr).not.toHaveBeenCalled();
		expect(persistCardPr).not.toHaveBeenCalled();
	});
});
