import type {
	RuntimeHookEvent,
	RuntimeHookIngestResponse,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import { parseHookIngestRequest } from "../core/api-validation";
import { loadWorkspaceContextById } from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { isNeedsInputReviewHook } from "../terminal/session-state-machine";
import { captureTaskTurnCheckpoint, deleteTaskTurnCheckpointRef } from "../workspace/turn-checkpoints";
import type { RuntimeTrpcContext } from "./app-router";

export interface CreateHooksApiDependencies {
	getWorkspacePathById: (workspaceId: string) => string | null;
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	broadcastTaskReadyForReview: (workspaceId: string, taskId: string) => void;
	notifyTaskReadyForReview?: (input: { workspaceId: string; workspacePath: string; taskId: string }) => Promise<void>;
	captureTaskTurnCheckpoint?: (input: {
		cwd: string;
		taskId: string;
		turn: number;
	}) => Promise<RuntimeTaskTurnCheckpoint>;
	deleteTaskTurnCheckpointRef?: (input: { cwd: string; ref: string }) => Promise<void>;
	// System backstop that guarantees an `autoReview=pr` card reaches Review with its
	// branch pushed and a PR open, independent of whether the agent opened one itself.
	// Fired fire-and-forget on `to_review`; a no-op for non-auto-PR cards and the home
	// agent. Optional so lightweight test contexts can omit or stub it.
	ensureAutoReviewPrForTask?: (input: { workspaceId: string; taskId: string; cwd: string }) => Promise<unknown>;
}

function canTransitionTaskForHookEvent(summary: RuntimeTaskSessionSummary, event: RuntimeHookEvent): boolean {
	if (event === "activity") {
		return false;
	}
	if (event === "to_review") {
		return summary.state === "running";
	}
	return summary.state === "awaiting_review";
}

export function createHooksApi(deps: CreateHooksApiDependencies): RuntimeTrpcContext["hooksApi"] {
	const checkpointCapture = deps.captureTaskTurnCheckpoint ?? captureTaskTurnCheckpoint;
	const checkpointRefDelete = deps.deleteTaskTurnCheckpointRef ?? deleteTaskTurnCheckpointRef;

	return {
		ingest: async (input) => {
			try {
				const body = parseHookIngestRequest(input);
				const taskId = body.taskId;
				const workspaceId = body.workspaceId;
				const event = body.event;
				const knownWorkspacePath = deps.getWorkspacePathById(workspaceId);
				const workspaceContext = knownWorkspacePath ? null : await loadWorkspaceContextById(workspaceId);
				const workspacePath = knownWorkspacePath ?? workspaceContext?.repoPath ?? null;
				if (!workspacePath) {
					return {
						ok: false,
						error: `Workspace "${workspaceId}" not found`,
					} satisfies RuntimeHookIngestResponse;
				}

				const manager = await deps.ensureTerminalManagerForWorkspace(workspaceId, workspacePath);
				const summary = manager.getSummary(taskId);
				if (!summary) {
					return {
						ok: false,
						error: `Task "${taskId}" not found in workspace "${workspaceId}"`,
					} satisfies RuntimeHookIngestResponse;
				}

				if (!canTransitionTaskForHookEvent(summary, event)) {
					if (body.metadata) {
						manager.applyHookActivity(taskId, body.metadata);
					}
					return {
						ok: true,
					} satisfies RuntimeHookIngestResponse;
				}

				// A permission prompt ("blocked — answer me") arrives as the same
				// `to_review` event as an end-of-turn stop ("done — review me"); the
				// hook metadata is what tells them apart, so lift the former reason.
				const reviewReason = isNeedsInputReviewHook(body.metadata) ? "needs_input" : "hook";
				const transitionedSummary =
					event === "to_review"
						? manager.transitionToReview(taskId, reviewReason)
						: manager.transitionToRunning(taskId);
				if (!transitionedSummary) {
					return {
						ok: false,
						error: `Task "${taskId}" transition failed`,
					} satisfies RuntimeHookIngestResponse;
				}

				if (event === "to_review") {
					const nextTurn = (transitionedSummary.latestTurnCheckpoint?.turn ?? 0) + 1;
					const checkpointCwd = transitionedSummary.workspacePath ?? workspacePath;
					const staleRef = transitionedSummary.previousTurnCheckpoint?.ref ?? null;
					// Fire-and-forget: the review transition already happened above, so the
					// hook ACK must not block on this. `checkpointCapture` runs `git add -A`
					// over the whole worktree, which can exceed the hook client's 3s timeout
					// on a post-verify worktree full of build/test artifacts.
					void checkpointCapture({
						cwd: checkpointCwd,
						taskId,
						turn: nextTurn,
					})
						.then((checkpoint) => {
							manager.applyTurnCheckpoint(taskId, checkpoint);
							if (staleRef) {
								void checkpointRefDelete({
									cwd: checkpointCwd,
									ref: staleRef,
								}).catch(() => {
									// Best effort cleanup only.
								});
							}
						})
						.catch(() => {
							// Best effort checkpointing only.
						});

					// Fire-and-forget, mirroring the checkpoint above: the review transition
					// already happened, so the hook ACK must not block on push+PR. This is the
					// system backstop that makes commit-but-no-PR structurally impossible for an
					// auto-PR card — it no-ops for every other card. A push/PR failure resolves
					// as a structured result (never a throw), so it can never crash the hook.
					void deps
						.ensureAutoReviewPrForTask?.({
							workspaceId,
							taskId,
							cwd: checkpointCwd,
						})
						.catch(() => {
							// Best effort PR backstop only.
						});
				}

				if (body.metadata) {
					manager.applyHookActivity(taskId, body.metadata);
				}

				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
				if (event === "to_review") {
					deps.broadcastTaskReadyForReview(workspaceId, taskId);
					void deps
						.notifyTaskReadyForReview?.({
							workspaceId,
							workspacePath,
							taskId,
						})
						.catch(() => {
							// Best effort only: a missing/stopped architect session is a clean no-op.
						});
				}

				return { ok: true } satisfies RuntimeHookIngestResponse;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, error: message } satisfies RuntimeHookIngestResponse;
			}
		},
	};
}
