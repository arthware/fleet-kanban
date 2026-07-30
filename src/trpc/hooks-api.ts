import { DRIVERS } from "../agents/driver";
import { SIGNAL_SEQUENCE_TRACKER } from "../agents/signal-sequence";
import type {
	RuntimeHookIngestResponse,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import { parseHookIngestRequest } from "../core/api-validation";
import { isHomeAgentSessionId, parseHomeAgentSessionId } from "../core/home-agent-session";
import { loadWorkspaceContextById, loadWorkspaceState } from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
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

				let agentId = summary.agentId;
				if (!agentId && isHomeAgentSessionId(taskId)) {
					const parsed = parseHomeAgentSessionId(taskId);
					agentId = parsed ? (parsed.agentId as any) : null;
				}

				if (!agentId) {
					try {
						const state = await loadWorkspaceState(workspacePath);
						const card = state.board.columns
							.flatMap((col) => col.cards)
							.find((c) => c.id === taskId);
						if (card) {
							agentId = card.agentId ?? null;
						}
					} catch {
						// Ignore board load errors
					}
				}

				if (!agentId) {
					if (body.metadata) {
						manager.applyHookActivity(taskId, body.metadata);
					}
					return { ok: true } satisfies RuntimeHookIngestResponse;
				}

				const driver = DRIVERS[agentId];
				if (!driver) {
					return {
						ok: false,
						error: `Driver not found for agent "${agentId}"`,
					} satisfies RuntimeHookIngestResponse;
				}

				const mappedSignalResult = driver.signals.mapNativeSignal({
					name: body.metadata?.hookEventName ?? event,
					payload: {
						sessionId: summary.agentSessionId || taskId,
						metadata: body.metadata,
					},
					observedAt: Date.now(),
				});

				if (!mappedSignalResult.supported) {
					if (body.metadata) {
						manager.applyHookActivity(taskId, body.metadata);
					}
					return { ok: true } satisfies RuntimeHookIngestResponse;
				}

				const signal = mappedSignalResult.value;

				// Check monotonic sequence tracking
				const lastSeq = manager.getLastProcessedSeq(taskId);
				if (signal.seq <= lastSeq) {
					// Drop stale/duplicate signal
					return { ok: true } satisfies RuntimeHookIngestResponse;
				}
				manager.setLastProcessedSeq(taskId, signal.seq);

				let transitionedSummary: RuntimeTaskSessionSummary | null = null;

				switch (signal.fact.type) {
					case "turn.started": {
						if (summary.state === "awaiting_review") {
							transitionedSummary = manager.transitionToRunning(taskId);
						}
						break;
					}
					case "turn.ended": {
						if (summary.state === "running") {
							transitionedSummary = manager.transitionToReview(taskId, "hook");
						}
						break;
					}
					case "attention.required": {
						if (summary.state === "running") {
							transitionedSummary = manager.transitionToReview(taskId, "needs_input");
						}
						break;
					}
					case "progress": {
						break;
					}
					case "session.ended": {
						SIGNAL_SEQUENCE_TRACKER.evictSession(summary.agentSessionId || taskId);
						if (summary.state === "running") {
							const reason = signal.fact.outcome === "completed" ? "exit" : "error";
							transitionedSummary = manager.transitionToReview(taskId, reason);
						}
						break;
					}
					default: {
						const _exhaustiveCheck: never = signal.fact;
						break;
					}
				}

				if (
					!transitionedSummary ||
					(transitionedSummary.state === summary.state &&
						transitionedSummary.reviewReason === summary.reviewReason)
				) {
					if (body.metadata) {
						manager.applyHookActivity(taskId, body.metadata);
					}
					return { ok: true } satisfies RuntimeHookIngestResponse;
				}

				const isTransitionToReview =
					signal.fact.type === "turn.ended" ||
					signal.fact.type === "attention.required" ||
					signal.fact.type === "session.ended";

				if (isTransitionToReview) {
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
				if (isTransitionToReview) {
					deps.broadcastTaskReadyForReview(workspaceId, taskId);
					void deps
						.notifyTaskReadyForReview?.({
							workspaceId,
							workspacePath,
							taskId,
						})
						.catch(() => {
							// Fire-and-forget only: a missing/stopped architect session is a clean no-op.
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
