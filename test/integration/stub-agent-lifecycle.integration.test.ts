import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeConfigResponse,
	RuntimeDesignDocResponse,
	RuntimeProjectsResponse,
	RuntimeTaskSessionStartResponse,
	RuntimeWorkspaceStateResponse,
	RuntimeWorktreeEnsureResponse,
} from "../../src/core/api-contract";
import {
	completeTaskAndGetReadyLinkedTaskIds,
	getTaskColumnId,
	moveTaskToColumn,
} from "../../src/core/task-board-mutations";
import {
	LINKED_CHILD_TASK_ID,
	LINKED_PARENT_TASK_ID,
	STUB_LIFECYCLE_TASK_ID,
	seedIsolatedBoardState,
} from "../utilities/board-seed";
import { createGitTestEnv } from "../utilities/git-env";
import { startIsolatedKanbanInstance } from "../utilities/kanban-test-instance";
import { createPetRepoFixtureCopy } from "../utilities/pet-repo-fixture";
import { requestJson } from "../utilities/trpc-request";

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv(),
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function findCard(board: RuntimeBoardData, taskId: string): RuntimeBoardCard {
	for (const column of board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) {
			return card;
		}
	}
	throw new Error(`Task ${taskId} not found.`);
}

function moveCard(board: RuntimeBoardData, taskId: string, columnId: RuntimeBoardColumnId): RuntimeBoardData {
	const moved = moveTaskToColumn(board, taskId, columnId);
	if (!moved.moved) {
		throw new Error(`Task ${taskId} did not move to ${columnId}.`);
	}
	return moved.board;
}

async function loadState(baseUrl: string, workspaceId: string): Promise<RuntimeWorkspaceStateResponse> {
	const response = await requestJson<RuntimeWorkspaceStateResponse>({
		baseUrl,
		procedure: "workspace.getState",
		type: "query",
		workspaceId,
	});
	expect(response.status).toBe(200);
	return response.payload;
}

async function resolveCurrentWorkspaceId(baseUrl: string): Promise<string> {
	const projects = await requestJson<RuntimeProjectsResponse>({
		baseUrl,
		procedure: "projects.list",
		type: "query",
	});
	expect(projects.status).toBe(200);
	if (!projects.payload.currentProjectId) {
		throw new Error("Expected isolated instance to have a current project.");
	}
	return projects.payload.currentProjectId;
}

async function saveBoard(input: {
	baseUrl: string;
	workspaceId: string;
	state: RuntimeWorkspaceStateResponse;
	board: RuntimeBoardData;
}): Promise<RuntimeWorkspaceStateResponse> {
	const response = await requestJson<RuntimeWorkspaceStateResponse>({
		baseUrl: input.baseUrl,
		procedure: "workspace.saveState",
		type: "mutation",
		workspaceId: input.workspaceId,
		payload: {
			board: input.board,
			sessions: input.state.sessions,
			expectedRevision: input.state.revision,
		},
	});
	expect(response.status).toBe(200);
	return response.payload;
}

async function waitFor<T>(resolveValue: () => Promise<T | null>, timeoutMs = 8_000): Promise<T> {
	const startedAt = Date.now();
	let lastValue: T | null = null;
	while (Date.now() - startedAt < timeoutMs) {
		lastValue = await resolveValue();
		if (lastValue !== null) {
			return lastValue;
		}
		await new Promise((resolvePoll) => setTimeout(resolvePoll, 100));
	}
	throw new Error(`Timed out waiting for condition. Last value: ${JSON.stringify(lastValue)}`);
}

async function startBoardTask(input: {
	baseUrl: string;
	workspaceId: string;
	card: RuntimeBoardCard;
}): Promise<RuntimeTaskSessionStartResponse> {
	const ensure = await requestJson<RuntimeWorktreeEnsureResponse>({
		baseUrl: input.baseUrl,
		procedure: "workspace.ensureWorktree",
		type: "mutation",
		workspaceId: input.workspaceId,
		payload: {
			taskId: input.card.id,
			baseRef: input.card.baseRef,
		},
	});
	expect(ensure.status).toBe(200);
	expect(ensure.payload.ok).toBe(true);

	const start = await requestJson<RuntimeTaskSessionStartResponse>({
		baseUrl: input.baseUrl,
		procedure: "runtime.startTaskSession",
		type: "mutation",
		workspaceId: input.workspaceId,
		payload: {
			taskId: input.card.id,
			prompt: input.card.prompt,
			taskTitle: input.card.title,
			startInPlanMode: input.card.startInPlanMode,
			baseRef: input.card.baseRef,
			agentId: input.card.agentId,
			cols: 100,
			rows: 30,
		},
	});
	expect(start.status).toBe(200);
	expect(start.payload.ok).toBe(true);
	expect(start.payload.summary?.state).toBe("running");
	return start.payload;
}

describe.sequential("GIVEN an isolated board seeded with a pet repo and a test-only stub agent", () => {
	it("WHEN a stub-agent card completes and its prerequisite is marked done THEN the board records review, done, and linked-card auto-start state", async () => {
		const fixture = createPetRepoFixtureCopy();
		const stubAgentPath = resolve(process.cwd(), "test/fixtures/stub-agent/stub-agent.mjs");
		expect(existsSync(stubAgentPath)).toBe(true);

		const instance = await startIsolatedKanbanInstance({
			cwd: fixture.path,
			env: {
				KANBAN_TEST_AGENT_BINARY: stubAgentPath,
			},
		});

		try {
			const runtimeBaseUrl = new URL(instance.baseUrl).origin;
			const workspaceId = await resolveCurrentWorkspaceId(runtimeBaseUrl);
			const fixtureRealPath = realpathSync(fixture.path);
			seedIsolatedBoardState({ homeDir: instance.homeDir, workspaceId });

			let state = await loadState(runtimeBaseUrl, workspaceId);
			expect(state.repoPath).toBe(fixtureRealPath);
			expect(getTaskColumnId(state.board, STUB_LIFECYCLE_TASK_ID)).toBe("backlog");

			const designDoc = await requestJson<RuntimeDesignDocResponse>({
				baseUrl: runtimeBaseUrl,
				procedure: "workspace.getDesignDoc",
				type: "query",
				workspaceId,
				payload: {
					taskId: STUB_LIFECYCLE_TASK_ID,
					externalIssueKey: "ENG-123",
				},
			});
			expect(designDoc.status).toBe(200);
			expect(designDoc.payload.exists).toBe(true);
			expect(designDoc.payload.path).toContain("docs/design/ENG-123-stub-lifecycle.md");

			const config = await requestJson<RuntimeConfigResponse>({
				baseUrl: runtimeBaseUrl,
				procedure: "runtime.getConfig",
				type: "query",
				workspaceId,
			});
			expect(config.status).toBe(200);
			expect(config.payload.effectiveCommand).toContain("stub-agent.mjs");

			const stubCard = findCard(state.board, STUB_LIFECYCLE_TASK_ID);
			const ensured = await requestJson<RuntimeWorktreeEnsureResponse>({
				baseUrl: runtimeBaseUrl,
				procedure: "workspace.ensureWorktree",
				type: "mutation",
				workspaceId,
				payload: {
					taskId: stubCard.id,
					baseRef: stubCard.baseRef,
				},
			});
			expect(ensured.status).toBe(200);
			expect(ensured.payload.ok).toBe(true);
			if (!ensured.payload.ok) {
				throw new Error("Expected worktree setup to succeed.");
			}
			expect(ensured.payload.baseRef).toBe("main");
			expect(ensured.payload.baseCommit).toBe(fixture.baseCommit);
			expect(runGit(ensured.payload.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
			expect(runGit(ensured.payload.path, ["rev-parse", "HEAD"])).toBe(fixture.baseCommit);

			state = await saveBoard({
				baseUrl: runtimeBaseUrl,
				workspaceId,
				state,
				board: moveCard(state.board, STUB_LIFECYCLE_TASK_ID, "in_progress"),
			});
			await startBoardTask({ baseUrl: runtimeBaseUrl, workspaceId, card: stubCard });

			const reviewState = await waitFor(async () => {
				const current = await loadState(runtimeBaseUrl, workspaceId);
				const summary = current.sessions[STUB_LIFECYCLE_TASK_ID];
				return summary?.state === "awaiting_review" && summary.exitCode === 0 ? current : null;
			});
			const reviewSummary = reviewState.sessions[STUB_LIFECYCLE_TASK_ID];
			expect(reviewSummary?.agentId).toBe("droid");
			expect(reviewSummary?.reviewReason).toBe("exit");
			expect(reviewSummary?.pid).toBeNull();
			expect(readFileSync(`${ensured.payload.path}/stub-agent-output.txt`, "utf8")).toContain(
				STUB_LIFECYCLE_TASK_ID,
			);
			const stubCommitMessage = runGit(ensured.payload.path, ["log", "-1", "--pretty=%s"]);
			expect(stubCommitMessage).toBe(`stub agent commit for ${STUB_LIFECYCLE_TASK_ID}`);
			expect(runGit(ensured.payload.path, ["status", "--short"])).toBe("");

			state = await saveBoard({
				baseUrl: runtimeBaseUrl,
				workspaceId,
				state: reviewState,
				board: moveCard(reviewState.board, STUB_LIFECYCLE_TASK_ID, "review"),
			});
			expect(getTaskColumnId(state.board, STUB_LIFECYCLE_TASK_ID)).toBe("review");

			const stubCompleted = completeTaskAndGetReadyLinkedTaskIds(state.board, STUB_LIFECYCLE_TASK_ID);
			expect(stubCompleted.moved).toBe(true);
			state = await saveBoard({
				baseUrl: runtimeBaseUrl,
				workspaceId,
				state,
				board: stubCompleted.board,
			});
			expect(getTaskColumnId(state.board, STUB_LIFECYCLE_TASK_ID)).toBe("done");

			const parentReviewBoard = moveCard(
				moveCard(state.board, LINKED_PARENT_TASK_ID, "in_progress"),
				LINKED_PARENT_TASK_ID,
				"review",
			);
			state = await saveBoard({
				baseUrl: runtimeBaseUrl,
				workspaceId,
				state,
				board: parentReviewBoard,
			});
			const completed = completeTaskAndGetReadyLinkedTaskIds(state.board, LINKED_PARENT_TASK_ID);
			expect(completed.readyTaskIds).toEqual([LINKED_CHILD_TASK_ID]);
			state = await saveBoard({
				baseUrl: runtimeBaseUrl,
				workspaceId,
				state,
				board: completed.board,
			});
			expect(getTaskColumnId(state.board, LINKED_PARENT_TASK_ID)).toBe("done");

			const linkedChild = findCard(state.board, LINKED_CHILD_TASK_ID);
			const childInProgress = moveCard(state.board, LINKED_CHILD_TASK_ID, "in_progress");
			state = await saveBoard({
				baseUrl: runtimeBaseUrl,
				workspaceId,
				state,
				board: childInProgress,
			});
			await startBoardTask({ baseUrl: runtimeBaseUrl, workspaceId, card: linkedChild });

			const childStartedState = await waitFor(async () => {
				const current = await loadState(runtimeBaseUrl, workspaceId);
				const summary = current.sessions[LINKED_CHILD_TASK_ID];
				return getTaskColumnId(current.board, LINKED_CHILD_TASK_ID) === "in_progress" &&
					(summary?.state === "running" || summary?.state === "awaiting_review")
					? current
					: null;
			});
			expect(childStartedState.sessions[LINKED_CHILD_TASK_ID]?.agentId).toBe("droid");
		} finally {
			await instance.stop();
			fixture.cleanup();
		}
	}, 20_000);
});
