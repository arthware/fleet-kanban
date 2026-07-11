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

import { createWorkspaceMetadataMonitor } from "../../../src/server/workspace-metadata-monitor";

const PR: CardPrRef = {
	url: "https://github.com/cline/kanban/pull/42",
	state: "open",
	number: 42,
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
		vi.clearAllMocks();
	});

	it("captures and persists the PR of a review card whose branch led to one", async () => {
		await monitor.connectWorkspace({
			workspaceId: "ws-1",
			workspacePath: "/repo",
			board: boardWith("review"),
		});

		expect(resolveCardPr).toHaveBeenCalledWith({ branch: "feature/task-1", cwd: "/worktrees/task-1" });
		expect(persistCardPr).toHaveBeenCalledTimes(1);
		expect(persistCardPr).toHaveBeenCalledWith({
			workspaceId: "ws-1",
			workspacePath: "/repo",
			taskId: "task-1",
			pr: PR,
		});
	});

	it("does not re-resolve a review card that already stores a PR", async () => {
		await monitor.connectWorkspace({
			workspaceId: "ws-1",
			workspacePath: "/repo",
			board: boardWith("review", { prUrl: PR.url, prState: "open", prNumber: 42 }),
		});

		expect(resolveCardPr).not.toHaveBeenCalled();
		expect(persistCardPr).not.toHaveBeenCalled();
	});

	it("leaves the card unset when no PR exists yet", async () => {
		resolveCardPr.mockResolvedValue(null);

		await monitor.connectWorkspace({
			workspaceId: "ws-1",
			workspacePath: "/repo",
			board: boardWith("review"),
		});

		expect(resolveCardPr).toHaveBeenCalledTimes(1);
		expect(persistCardPr).not.toHaveBeenCalled();
	});

	it("does not resolve PRs for in-progress cards", async () => {
		await monitor.connectWorkspace({
			workspaceId: "ws-1",
			workspacePath: "/repo",
			board: boardWith("in_progress"),
		});

		expect(resolveCardPr).not.toHaveBeenCalled();
		expect(persistCardPr).not.toHaveBeenCalled();
	});
});
