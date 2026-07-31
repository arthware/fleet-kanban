// Streams live runtime state to browser clients over websocket.
// It listens to terminal updates, normalizes them into the
// shared API contract, and fans out workspace-scoped snapshots and deltas.
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type {
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeStateStreamErrorMessage,
	RuntimeStateStreamMessage,
	RuntimeStateStreamProjectsMessage,
	RuntimeStateStreamSnapshotMessage,
	RuntimeStateStreamTaskChatClearedMessage,
	RuntimeStateStreamTaskReadyForReviewMessage,
	RuntimeStateStreamTaskSessionsMessage,
	RuntimeStateStreamWorkspaceMetadataMessage,
	RuntimeStateStreamWorkspaceStateMessage,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { getTaskColumnId, moveTaskToColumn, setCardPrUrl } from "../core/task-board-mutations";
import { mutateWorkspaceStateById } from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { createWorkspaceMetadataMonitor } from "./workspace-metadata-monitor";
import type { ResolvedWorkspaceStreamTarget, WorkspaceRegistry } from "./workspace-registry";

export function getTargetColumnForSession(summary: {
	taskId: string;
	state: RuntimeTaskSessionState;
}): RuntimeBoardColumnId | null {
	if (isHomeAgentSessionId(summary.taskId)) {
		return null;
	}
	switch (summary.state) {
		case "awaiting_review":
			return "review";
		case "running":
			return "in_progress";
		case "idle":
		case "failed":
		case "interrupted":
			return null;
		default: {
			const _exhaustive: never = summary.state;
			return null;
		}
	}
}

export async function projectSessionSummaryColumn(
	workspaceId: string,
	summary: { taskId: string; state: RuntimeTaskSessionState },
	_workspaceRegistry: Pick<WorkspaceRegistry, "getWorkspacePathById">,
	broadcastWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void>,
): Promise<boolean> {
	const targetColumnId = getTargetColumnForSession(summary);
	if (!targetColumnId) {
		return false;
	}
	try {
		const mutation = await mutateWorkspaceStateById(workspaceId, (state) => {
			const previousColumnId = getTaskColumnId(state.board, summary.taskId);
			if (!previousColumnId || previousColumnId === targetColumnId) {
				return { board: state.board, value: false, save: false };
			}
			const moved = moveTaskToColumn(state.board, summary.taskId, targetColumnId, Date.now());
			return { board: moved.board, value: moved.moved, save: moved.moved };
		});
		if (mutation.saved && mutation.value) {
			await broadcastWorkspaceStateUpdated(workspaceId, mutation.state.repoPath);
			return true;
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.stack || error.message : String(error);
		process.stderr.write(
			`[kanban] Background projection mutation failed for task "${summary.taskId}" in workspace "${workspaceId}": ${errorMessage}\n`,
		);
	}
	return false;
}

/**
 * Write back an agent session id that only became known after the agent booted.
 *
 * Claude is told its session id up front, so the row written when the session starts
 * already carries it. Codex and Gemini mint their own and reveal it only once they have
 * written their first transcript, so the session manager discovers it in the background
 * and emits an updated summary. Without persisting that emit the id lived only in memory:
 * after a restart the card had no pointer to its conversation and rendered as a dead card
 * with an empty transcript panel.
 *
 * Bounded by construction — it writes only when the persisted id differs from the emitted
 * one, so a card costs at most one write per discovered id, never one per summary emit.
 */
export async function persistDiscoveredAgentSessionId(
	workspaceId: string,
	summary: RuntimeTaskSessionSummary,
): Promise<boolean> {
	if (!summary.agentSessionId) {
		return false;
	}
	try {
		const mutation = await mutateWorkspaceStateById(workspaceId, (state) => {
			const existing = state.sessions[summary.taskId];
			if (existing?.agentSessionId === summary.agentSessionId) {
				return { board: state.board, value: false, save: false };
			}
			// Discovery can land before the starting request has written its row; in that
			// case the emitted summary is the session, so store it whole.
			const nextSession: RuntimeTaskSessionSummary = existing
				? {
						...existing,
						agentSessionId: summary.agentSessionId,
						agentSessionLifecycle: summary.agentSessionLifecycle,
					}
				: summary;
			return {
				board: state.board,
				sessions: { ...state.sessions, [summary.taskId]: nextSession },
				value: true,
				save: true,
			};
		});
		return mutation.saved && mutation.value;
	} catch (error) {
		const errorMessage = error instanceof Error ? error.stack || error.message : String(error);
		process.stderr.write(
			`[kanban] Persisting discovered agent session id failed for task "${summary.taskId}" in workspace "${workspaceId}": ${errorMessage}\n`,
		);
	}
	return false;
}

const TASK_SESSION_STREAM_BATCH_MS = 150;

// The initial snapshot assembly (project payload + workspace state + metadata monitor
// connect) shells out to git per project and reads board state. If any step blocks, the
// websocket would otherwise stay open forever with no snapshot — wedging every client on
// a blank loader with nothing to surface. Bounding it turns a stuck workspace into a
// reported error + client reconnect instead of an infinite hang.
export const SNAPSHOT_ASSEMBLY_TIMEOUT_MS = 10_000;

export class SnapshotAssemblyTimeoutError extends Error {
	constructor(stage: string, timeoutMs: number) {
		super(`Runtime snapshot assembly timed out after ${timeoutMs}ms (${stage}).`);
		this.name = "SnapshotAssemblyTimeoutError";
	}
}

/**
 * Reject if `promise` has not settled within `timeoutMs`. `stage` names the assembly
 * step so a timeout error is self-describing in the client-facing `error` message.
 */
export function withSnapshotTimeout<T>(
	promise: Promise<T>,
	stage: string,
	timeoutMs: number = SNAPSHOT_ASSEMBLY_TIMEOUT_MS,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new SnapshotAssemblyTimeoutError(stage, timeoutMs));
		}, timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

export interface DisposeRuntimeStateWorkspaceOptions {
	disconnectClients?: boolean;
	closeClientErrorMessage?: string;
}

export interface CreateRuntimeStateHubDependencies {
	workspaceRegistry: Pick<
		WorkspaceRegistry,
		"resolveWorkspaceForStream" | "buildProjectsPayload" | "buildWorkspaceStateSnapshot" | "getWorkspacePathById"
	>;
	heartbeatIntervalMs?: number;
}

export interface RuntimeStateHub {
	trackTerminalManager: (workspaceId: string, manager: TerminalSessionManager) => void;
	broadcastTaskChatCleared: (workspaceId: string, taskId: string) => void;
	handleUpgrade: (
		request: IncomingMessage,
		socket: Parameters<WebSocketServer["handleUpgrade"]>[1],
		head: Buffer,
		context: {
			requestedWorkspaceId: string | null;
		},
	) => void;
	disposeWorkspace: (workspaceId: string, options?: DisposeRuntimeStateWorkspaceOptions) => void;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void>;
	broadcastRuntimeProjectsUpdated: (preferredCurrentProjectId: string | null) => Promise<void>;
	broadcastTaskReadyForReview: (workspaceId: string, taskId: string) => void;
	close: () => Promise<void>;
}

export function applyPersistedCardPrToBoard(
	board: RuntimeBoardData,
	taskId: string,
	pr: { url: string; state: "open" | "merged" | "closed"; number: number },
): { board: RuntimeBoardData; updated: boolean } {
	const previousColumnId = getTaskColumnId(board, taskId);
	const result = setCardPrUrl(board, taskId, pr);
	if (!result.updated) {
		return result;
	}
	if (pr.state !== "merged" && pr.state !== "closed") {
		return result;
	}
	if (previousColumnId !== "in_progress" && previousColumnId !== "review") {
		return result;
	}
	// Closed-without-merge PRs are archived to trash by design, so abandoned work
	// does not auto-start linked dependent cards.
	const targetColumnId = pr.state === "merged" ? "done" : "trash";
	const moved = moveTaskToColumn(result.board, taskId, targetColumnId);
	return { board: moved.board, updated: true };
}

export function createRuntimeStateHub(deps: CreateRuntimeStateHubDependencies): RuntimeStateHub {
	const terminalSummaryUnsubscribeByWorkspaceId = new Map<string, () => void>();
	const pendingTaskSessionSummariesByWorkspaceId = new Map<string, Map<string, RuntimeTaskSessionSummary>>();
	const taskSessionBroadcastTimersByWorkspaceId = new Map<string, NodeJS.Timeout>();
	const runtimeStateClientsByWorkspaceId = new Map<string, Set<WebSocket>>();
	const runtimeStateClients = new Set<WebSocket>();
	const runtimeStateWorkspaceIdByClient = new Map<WebSocket, string>();
	const responsiveClients = new Set<WebSocket>();
	const runtimeStateWebSocketServer = new WebSocketServer({ noServer: true });
	const workspaceMetadataMonitor = createWorkspaceMetadataMonitor({
		onMetadataUpdated: (workspaceId, workspaceMetadata) => {
			const clients = runtimeStateClientsByWorkspaceId.get(workspaceId);
			if (!clients || clients.size === 0) {
				return;
			}
			const payload: RuntimeStateStreamWorkspaceMetadataMessage = {
				type: "workspace_metadata_updated",
				workspaceId,
				workspaceMetadata,
			};
			for (const client of clients) {
				sendRuntimeStateMessage(client, payload);
			}
		},
		// Persist a detected PR onto the card, then push the updated board to
		// clients so the card renders its live PR state. `setCardPrUrl` is
		// idempotent and `mutateWorkspaceState` skips the write when nothing changed.
		persistCardPr: async ({ workspaceId, workspacePath, taskId, pr }) => {
			const mutation = await mutateWorkspaceStateById(workspaceId, (state) => {
				const result = applyPersistedCardPrToBoard(state.board, taskId, pr);
				return { board: result.board, value: result.updated, save: result.updated };
			});
			if (mutation.value) {
				await broadcastRuntimeWorkspaceStateUpdated(workspaceId, mutation.state.repoPath);
			}
		},
	});

	const sendRuntimeStateMessage = (client: WebSocket, payload: RuntimeStateStreamMessage) => {
		if (client.readyState !== WebSocket.OPEN) {
			return;
		}
		try {
			client.send(JSON.stringify(payload));
		} catch {
			// Ignore websocket write errors; close handlers clean up disconnected sockets.
		}
	};

	const broadcastRuntimeProjectsUpdated = async (preferredCurrentProjectId: string | null): Promise<void> => {
		if (runtimeStateClients.size === 0) {
			return;
		}
		try {
			const payload = await deps.workspaceRegistry.buildProjectsPayload(preferredCurrentProjectId);
			for (const client of runtimeStateClients) {
				sendRuntimeStateMessage(client, {
					type: "projects_updated",
					currentProjectId: payload.currentProjectId,
					projects: payload.projects,
					architectWorkspaceId: payload.architectWorkspaceId,
				} satisfies RuntimeStateStreamProjectsMessage);
			}
		} catch {
			// Ignore transient project summary failures; next update will resync.
		}
	};

	const flushTaskSessionSummaries = (workspaceId: string) => {
		const pending = pendingTaskSessionSummariesByWorkspaceId.get(workspaceId);
		if (!pending || pending.size === 0) {
			return;
		}
		pendingTaskSessionSummariesByWorkspaceId.delete(workspaceId);
		const summaries = Array.from(pending.values());
		const runtimeClients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (runtimeClients && runtimeClients.size > 0) {
			const payload: RuntimeStateStreamTaskSessionsMessage = {
				type: "task_sessions_updated",
				workspaceId,
				summaries,
			};
			for (const client of runtimeClients) {
				sendRuntimeStateMessage(client, payload);
			}
		}
		void broadcastRuntimeProjectsUpdated(workspaceId);
	};

	const queueTaskSessionSummaryBroadcast = (workspaceId: string, summary: RuntimeTaskSessionSummary) => {
		const pending =
			pendingTaskSessionSummariesByWorkspaceId.get(workspaceId) ?? new Map<string, RuntimeTaskSessionSummary>();
		pending.set(summary.taskId, summary);
		pendingTaskSessionSummariesByWorkspaceId.set(workspaceId, pending);
		if (taskSessionBroadcastTimersByWorkspaceId.has(workspaceId)) {
			return;
		}
		const timer = setTimeout(() => {
			taskSessionBroadcastTimersByWorkspaceId.delete(workspaceId);
			flushTaskSessionSummaries(workspaceId);
		}, TASK_SESSION_STREAM_BATCH_MS);
		timer.unref();
		taskSessionBroadcastTimersByWorkspaceId.set(workspaceId, timer);
	};

	const broadcastTaskChatCleared = (workspaceId: string, taskId: string) => {
		const runtimeClients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (!runtimeClients || runtimeClients.size === 0) {
			return;
		}
		const payload: RuntimeStateStreamTaskChatClearedMessage = {
			type: "task_chat_cleared",
			workspaceId,
			taskId,
		};
		for (const client of runtimeClients) {
			sendRuntimeStateMessage(client, payload);
		}
	};

	const disposeTaskSessionSummaryBroadcast = (workspaceId: string) => {
		const timer = taskSessionBroadcastTimersByWorkspaceId.get(workspaceId);
		if (timer) {
			clearTimeout(timer);
		}
		taskSessionBroadcastTimersByWorkspaceId.delete(workspaceId);
		pendingTaskSessionSummariesByWorkspaceId.delete(workspaceId);
	};

	const cleanupRuntimeStateClient = (client: WebSocket) => {
		const workspaceId = runtimeStateWorkspaceIdByClient.get(client);
		if (workspaceId) {
			workspaceMetadataMonitor.disconnectWorkspace(workspaceId);
			const clients = runtimeStateClientsByWorkspaceId.get(workspaceId);
			if (clients) {
				clients.delete(client);
				if (clients.size === 0) {
					runtimeStateClientsByWorkspaceId.delete(workspaceId);
				}
			}
		}
		runtimeStateWorkspaceIdByClient.delete(client);
		runtimeStateClients.delete(client);
		responsiveClients.delete(client);
	};

	const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 20_000;
	const heartbeatInterval = setInterval(() => {
		for (const client of runtimeStateClients) {
			if (!responsiveClients.has(client)) {
				try {
					client.terminate();
				} catch {
					// Ignore termination errors.
				}
				cleanupRuntimeStateClient(client);
			} else {
				responsiveClients.delete(client);
				sendRuntimeStateMessage(client, { type: "heartbeat" });
				try {
					client.ping();
				} catch {
					try {
						client.terminate();
					} catch {
						// Ignore termination errors.
					}
					cleanupRuntimeStateClient(client);
				}
			}
		}
	}, heartbeatIntervalMs);

	const disposeWorkspace = (workspaceId: string, options?: DisposeRuntimeStateWorkspaceOptions) => {
		const unsubscribeSummary = terminalSummaryUnsubscribeByWorkspaceId.get(workspaceId);
		if (unsubscribeSummary) {
			try {
				unsubscribeSummary();
			} catch {
				// Ignore listener cleanup errors during project removal.
			}
		}
		terminalSummaryUnsubscribeByWorkspaceId.delete(workspaceId);
		disposeTaskSessionSummaryBroadcast(workspaceId);
		workspaceMetadataMonitor.disposeWorkspace(workspaceId);

		if (!options?.disconnectClients) {
			return;
		}

		const runtimeClients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (!runtimeClients || runtimeClients.size === 0) {
			runtimeStateClientsByWorkspaceId.delete(workspaceId);
			return;
		}

		for (const runtimeClient of runtimeClients) {
			if (options.closeClientErrorMessage) {
				sendRuntimeStateMessage(runtimeClient, {
					type: "error",
					message: options.closeClientErrorMessage,
				} satisfies RuntimeStateStreamErrorMessage);
			}
			try {
				runtimeClient.close();
			} catch {
				// Ignore close failures while disposing removed workspace clients.
			}
			cleanupRuntimeStateClient(runtimeClient);
		}
		runtimeStateClientsByWorkspaceId.delete(workspaceId);
	};

	const broadcastRuntimeWorkspaceStateUpdated = async (workspaceId: string, workspacePath: string): Promise<void> => {
		let workspaceState: RuntimeStateStreamWorkspaceStateMessage["workspaceState"];
		try {
			workspaceState = await deps.workspaceRegistry.buildWorkspaceStateSnapshot(workspaceId, workspacePath);
		} catch {
			// Ignore transient state read failures; next update will resync.
			return;
		}

		void workspaceMetadataMonitor
			.updateWorkspaceState({
				workspaceId,
				workspacePath,
				board: workspaceState.board,
			})
			.catch(() => {
				// Metadata is eventually consistent and must not block board-state fanout.
			});

		const clients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (!clients || clients.size === 0) {
			return;
		}
		try {
			const payload: RuntimeStateStreamWorkspaceStateMessage = {
				type: "workspace_state_updated",
				workspaceId,
				workspaceState,
			};
			for (const client of clients) {
				sendRuntimeStateMessage(client, payload);
			}
		} catch {
			// Ignore websocket fanout failures; next update will resync.
		}
	};

	const broadcastTaskReadyForReview = (workspaceId: string, taskId: string) => {
		const runtimeClients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (!runtimeClients || runtimeClients.size === 0) {
			return;
		}
		const payload: RuntimeStateStreamTaskReadyForReviewMessage = {
			type: "task_ready_for_review",
			workspaceId,
			taskId,
			triggeredAt: Date.now(),
		};
		for (const client of runtimeClients) {
			sendRuntimeStateMessage(client, payload);
		}
	};

	runtimeStateWebSocketServer.on("connection", async (client: WebSocket, context: unknown) => {
		client.on("close", () => {
			cleanupRuntimeStateClient(client);
		});
		try {
			const requestedWorkspaceId =
				typeof context === "object" &&
				context !== null &&
				"requestedWorkspaceId" in context &&
				typeof (context as { requestedWorkspaceId?: unknown }).requestedWorkspaceId === "string"
					? (context as { requestedWorkspaceId: string }).requestedWorkspaceId || null
					: null;
			const workspace: ResolvedWorkspaceStreamTarget =
				await deps.workspaceRegistry.resolveWorkspaceForStream(requestedWorkspaceId);
			if (client.readyState !== WebSocket.OPEN) {
				cleanupRuntimeStateClient(client);
				return;
			}

			/*
				Connection setup for workspace-scoped runtime streams is intentionally split into two phases.

				We need the initial snapshot to already contain the first workspace metadata payload, but we do not want
				the client to receive a separate "workspace_metadata_updated" event before that snapshot arrives.

				That race can happen if we register the websocket in runtimeStateClientsByWorkspaceId first and then call
				workspaceMetadataMonitor.connectWorkspace(...). connectWorkspace() performs an immediate refresh, and that
				refresh may broadcast "workspace_metadata_updated" to every currently registered workspace client. In that
				old ordering, a newly connected client could observe:

				1. workspace_metadata_updated
				2. snapshot

				which makes the initial load look wrong and forces the UI to process the same logical data twice in the
				opposite order from what readers expect.

				To avoid that, we:

				1. add the socket only to the global runtimeStateClients set so project-wide broadcasts still work
				2. build workspace state and connect the metadata monitor to get the initial metadata snapshot
				3. send the combined "snapshot" message
				4. only then register the socket in runtimeStateClientsByWorkspaceId so future incremental
				   workspace_metadata_updated events can flow normally

				The extra readyState checks and monitor cleanup below are paired with this delayed registration. If the
				socket closes while we are still assembling or sending the initial snapshot, we must disconnect the
				temporary metadata monitor subscription before returning, otherwise we would leave behind subscriber count
				state for a client that never finished the handshake.
			*/
			runtimeStateClients.add(client);
			responsiveClients.add(client);
			client.on("pong", () => {
				responsiveClients.add(client);
			});
			let monitorWorkspaceId: string | null = null;
			let didConnectWorkspaceMonitor = false;

			try {
				let projectsPayload: {
					currentProjectId: string | null;
					projects: RuntimeStateStreamProjectsMessage["projects"];
					architectWorkspaceId: string | null;
				};
				let workspaceState: RuntimeStateStreamSnapshotMessage["workspaceState"];
				let workspaceMetadata: RuntimeStateStreamSnapshotMessage["workspaceMetadata"];
				if (workspace.workspaceId && workspace.workspacePath) {
					monitorWorkspaceId = workspace.workspaceId;
					[projectsPayload, workspaceState] = await withSnapshotTimeout(
						Promise.all([
							deps.workspaceRegistry.buildProjectsPayload(workspace.workspaceId),
							deps.workspaceRegistry.buildWorkspaceStateSnapshot(workspace.workspaceId, workspace.workspacePath),
						]),
						"workspace state",
					);
					workspaceMetadata = await withSnapshotTimeout(
						workspaceMetadataMonitor.connectWorkspace({
							workspaceId: workspace.workspaceId,
							workspacePath: workspace.workspacePath,
							board: workspaceState.board,
						}),
						"workspace metadata",
					);
					didConnectWorkspaceMonitor = true;
				} else {
					projectsPayload = await withSnapshotTimeout(
						deps.workspaceRegistry.buildProjectsPayload(null),
						"projects payload",
					);
					workspaceState = null;
					workspaceMetadata = null;
				}
				if (client.readyState !== WebSocket.OPEN) {
					if (monitorWorkspaceId) {
						workspaceMetadataMonitor.disconnectWorkspace(monitorWorkspaceId);
					}
					cleanupRuntimeStateClient(client);
					return;
				}
				sendRuntimeStateMessage(client, {
					type: "snapshot",
					currentProjectId: projectsPayload.currentProjectId,
					projects: projectsPayload.projects,
					architectWorkspaceId: projectsPayload.architectWorkspaceId,
					workspaceState,
					workspaceMetadata,
				} satisfies RuntimeStateStreamSnapshotMessage);
				if (client.readyState !== WebSocket.OPEN) {
					if (monitorWorkspaceId) {
						workspaceMetadataMonitor.disconnectWorkspace(monitorWorkspaceId);
					}
					cleanupRuntimeStateClient(client);
					return;
				}
				if (monitorWorkspaceId) {
					const workspaceClients =
						runtimeStateClientsByWorkspaceId.get(monitorWorkspaceId) ?? new Set<WebSocket>();
					workspaceClients.add(client);
					runtimeStateClientsByWorkspaceId.set(monitorWorkspaceId, workspaceClients);
					runtimeStateWorkspaceIdByClient.set(client, monitorWorkspaceId);
				}
			} catch (error) {
				if (didConnectWorkspaceMonitor && monitorWorkspaceId) {
					workspaceMetadataMonitor.disconnectWorkspace(monitorWorkspaceId);
				}
				const message = error instanceof Error ? error.message : String(error);
				sendRuntimeStateMessage(client, {
					type: "error",
					message,
				} satisfies RuntimeStateStreamErrorMessage);
				// Close so a snapshot that never assembled (e.g. a timed-out git probe)
				// drops the client into its reconnect/backoff path instead of leaving it
				// holding a socket that will never receive a snapshot.
				client.close();
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendRuntimeStateMessage(client, {
				type: "error",
				message,
			} satisfies RuntimeStateStreamErrorMessage);
			client.close();
		}
	});

	return {
		trackTerminalManager: (workspaceId: string, manager: TerminalSessionManager) => {
			if (terminalSummaryUnsubscribeByWorkspaceId.has(workspaceId)) {
				return;
			}
			const unsubscribe = manager.onSummary((summary) => {
				queueTaskSessionSummaryBroadcast(workspaceId, summary);
				void projectSessionSummaryColumn(
					workspaceId,
					summary,
					deps.workspaceRegistry,
					broadcastRuntimeWorkspaceStateUpdated,
				).catch(() => {
					// Ignore background projection error
				});
				void persistDiscoveredAgentSessionId(workspaceId, summary).catch(() => {
					// Ignore background session identity writeback error
				});
			});
			terminalSummaryUnsubscribeByWorkspaceId.set(workspaceId, unsubscribe);
		},
		broadcastTaskChatCleared,
		handleUpgrade: (request, socket, head, context) => {
			runtimeStateWebSocketServer.handleUpgrade(request, socket, head, (ws) => {
				runtimeStateWebSocketServer.emit("connection", ws, context);
			});
		},
		disposeWorkspace,
		broadcastRuntimeWorkspaceStateUpdated,
		broadcastRuntimeProjectsUpdated,
		broadcastTaskReadyForReview,
		close: async () => {
			clearInterval(heartbeatInterval);
			for (const timer of taskSessionBroadcastTimersByWorkspaceId.values()) {
				clearTimeout(timer);
			}
			taskSessionBroadcastTimersByWorkspaceId.clear();
			pendingTaskSessionSummariesByWorkspaceId.clear();
			for (const unsubscribe of terminalSummaryUnsubscribeByWorkspaceId.values()) {
				try {
					unsubscribe();
				} catch {
					// Ignore listener cleanup errors during shutdown.
				}
			}
			terminalSummaryUnsubscribeByWorkspaceId.clear();
			workspaceMetadataMonitor.close();
			for (const client of runtimeStateClients) {
				try {
					client.terminate();
				} catch {
					// Ignore websocket termination errors during shutdown.
				}
			}
			runtimeStateClients.clear();
			runtimeStateClientsByWorkspaceId.clear();
			runtimeStateWorkspaceIdByClient.clear();
			await new Promise<void>((resolveCloseWebSockets) => {
				runtimeStateWebSocketServer.close(() => {
					resolveCloseWebSockets();
				});
			});
		},
	};
}
