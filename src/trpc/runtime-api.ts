// Coordinates the runtime-side TRPC handlers used by the browser.
// This is the main backend entrypoint for sessions, settings, git, and
// workspace actions, while terminal-specific behavior stays in focused
// services instead of accumulating here.

import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { TRPCError } from "@trpc/server";
import { DRIVERS } from "../agents/driver";
import type { RuntimeConfigState } from "../config/runtime-config";
import { getRuntimeDebugResetPaths, updateGlobalRuntimeConfig, updateRuntimeConfig } from "../config/runtime-config";
import type {
	RuntimeCommandRunResponse,
	RuntimeRunUpdateResponse,
	RuntimeTaskAutoReviewMode,
	RuntimeTaskReviewNotificationResponse,
	RuntimeTaskSessionSummary,
	RuntimeTaskTokenUsage,
	RuntimeUpdateStatusResponse,
} from "../core/api-contract";
import {
	parseCommandRunRequest,
	parseHomeAgentFreshStartRequest,
	parseRuntimeConfigSaveRequest,
	parseShellSessionStartRequest,
	parseTaskReviewNotificationRequest,
	parseTaskSessionInputRequest,
	parseTaskSessionStartRequest,
	parseTaskSessionStopRequest,
	parseTaskTokenUsageRequest,
	parseTaskTranscriptRequest,
} from "../core/api-validation";
import { resolveStartActiveSkills, validateSkill } from "../core/card-type";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import {
	buildTaskReadyForReviewMessage,
	buildTaskReviewNotificationKey,
	hasReviewNotificationBeenSent,
	resolveRunningHomeAgentTaskId,
} from "../core/review-notification";
import { readFileIfExists } from "../fs/read-file-if-exists";
import { loadCardTypeManifest } from "../prompts/card-type-discovery";
import { composeCardDirective } from "../prompts/compose-card-directive";
import { loadDoctrine, prependConstitution, type ReadFileIfExists } from "../prompts/doctrine";
import { getAgentBudget } from "../server/agent-budget";
import {
	type RegisteredWorkspace,
	resolveArchitectHomeAgentWorkspaceId,
	resolveDoctrineScope,
	resolveHomeAgentContext,
} from "../server/architect-workspace";
import { openInBrowser } from "../server/browser";
import { applyFleetUpdate, getFleetUpdateStatus } from "../server/fleet-update-status";
import {
	listWorkspacesWithEpic,
	loadWorkspaceContextById,
	loadWorkspaceState,
	mutateWorkspaceState,
} from "../state/workspace-state";
import { buildRuntimeConfigResponse, resolveAgentCommand } from "../terminal/agent-registry";
import { readAgentTranscript } from "../terminal/agent-transcript-reader";
import { readAgentUsage } from "../terminal/agent-usage-reader";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { resolveTaskCwd } from "../workspace/task-worktree";
import { captureTaskTurnCheckpoint } from "../workspace/turn-checkpoints";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "./app-router";

export interface CreateRuntimeApiDependencies {
	getActiveWorkspaceId: () => string | null;
	getActiveRuntimeConfig?: () => RuntimeConfigState;
	loadScopedRuntimeConfig: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeConfigState>;
	setActiveRuntimeConfig: (config: RuntimeConfigState) => void;
	getScopedTerminalManager: (scope: RuntimeTrpcWorkspaceScope) => Promise<TerminalSessionManager>;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	runCommand: (command: string, cwd: string) => Promise<RuntimeCommandRunResponse>;
	/** Reads a doctrine file (constitution) for prompt injection; defaults to the real filesystem. */
	readDoctrineFile?: ReadFileIfExists;
	/** Lists the registered workspace index; injected so tests control architect classification. Defaults to the real index. */
	listWorkspaces?: () => Promise<RegisteredWorkspace[]>;
	broadcastTaskChatCleared?: (workspaceId: string, taskId: string) => void;
	prepareForStateReset?: () => Promise<void>;
	getUpdateStatus: () => RuntimeUpdateStatusResponse;
	runUpdateNow: () => Promise<RuntimeRunUpdateResponse>;
	/** Sums in-progress task counts across all registered projects; the fleet-update apply gate. */
	getFleetUpdateInProgressCount: () => Promise<number>;
	/**
	 * Waits `ms` before the bracketed-paste submit Enter is written, so the paste
	 * settles into its own PTY read first.
	 * Defaults to a real timer; injected so tests drive the deferral deterministically.
	 */
	delay?: (ms: number) => Promise<void>;
}

function resumeSessionForHumanInput(
	terminalManager: TerminalSessionManager,
	taskId: string,
	summary: RuntimeTaskSessionSummary,
): RuntimeTaskSessionSummary {
	if (summary.state !== "awaiting_review") {
		return summary;
	}
	return terminalManager.resumeFromHumanInput(taskId) ?? summary;
}

async function resolveExistingTaskCwdOrEnsure(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
}): Promise<string> {
	try {
		return await resolveTaskCwd({
			cwd: options.cwd,
			taskId: options.taskId,
			baseRef: options.baseRef,
			ensure: false,
		});
	} catch {
		return await resolveTaskCwd({
			cwd: options.cwd,
			taskId: options.taskId,
			baseRef: options.baseRef,
			ensure: true,
		});
	}
}

async function persistTaskSessionSummary(workspacePath: string, summary: RuntimeTaskSessionSummary): Promise<void> {
	await mutateWorkspaceState(workspacePath, (state) => ({
		board: state.board,
		sessions: {
			...state.sessions,
			[summary.taskId]: summary,
		},
		value: null,
	}));
}

async function persistReviewNotificationKey(
	workspacePath: string,
	taskId: string,
	reviewNotificationKey: string,
): Promise<void> {
	await mutateWorkspaceState(workspacePath, (state) => {
		const existing = state.sessions[taskId];
		if (!existing) {
			return {
				board: state.board,
				sessions: state.sessions,
				value: null,
			};
		}
		return {
			board: state.board,
			sessions: {
				...state.sessions,
				[taskId]: {
					...existing,
					lastReviewNotificationKey: reviewNotificationKey,
				},
			},
			value: null,
		};
	});
}

export function createRuntimeApi(deps: CreateRuntimeApiDependencies): RuntimeTrpcContext["runtimeApi"] {
	const debugResetTargetPaths = getRuntimeDebugResetPaths();

	const buildConfigResponse = (runtimeConfig: RuntimeConfigState) => buildRuntimeConfigResponse(runtimeConfig);

	const delay = deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

	const sendTaskSessionInput: RuntimeTrpcContext["runtimeApi"]["sendTaskSessionInput"] = async (
		workspaceScope,
		input,
	) => {
		try {
			const body = parseTaskSessionInputRequest(input);
			// Submit-only path: if body.text is empty, write a lone \r directly and return.
			if (body.text === "") {
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const existingSummary = terminalManager.getSummary(body.taskId);
				if (!existingSummary) {
					return {
						ok: false,
						summary: null,
						error: "Task session is not running.",
					};
				}
				const resumedSummary = resumeSessionForHumanInput(terminalManager, body.taskId, existingSummary);
				const summary = terminalManager.writeInput(body.taskId, Buffer.from("\r", "utf8"));
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task session is not running.",
					};
				}
				return {
					ok: true,
					summary: summary.state === resumedSummary.state ? summary : resumedSummary,
				};
			}

			const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
			let summary = terminalManager.getSummary(body.taskId);
			if (!summary) {
				return {
					ok: false,
					summary: null,
					error: "Task session is not running.",
				};
			}
			summary = resumeSessionForHumanInput(terminalManager, body.taskId, summary);

			if (body.bracketedPaste) {
				const agentId = summary.agentId;
				if (!agentId) {
					return {
						ok: false,
						summary,
						error: "No agent is assigned to this task session.",
					};
				}
				const driver = DRIVERS[agentId];
				if (!driver) {
					return {
						ok: false,
						summary,
						error: `Unknown driver for agent: ${agentId}`,
					};
				}
				const controlResult = await driver.control.steer({
					text: body.text,
					submit: body.submit ?? true,
				});
				if (!controlResult.supported) {
					return {
						ok: false,
						summary,
						error: controlResult.reason,
					};
				}
				const plan = controlResult.value;
				for (const step of plan) {
					if (step.type === "write") {
						const afterWrite = terminalManager.writeInput(body.taskId, Buffer.from(step.data, "utf8"));
						if (afterWrite) {
							summary = afterWrite;
						} else {
							return {
								ok: false,
								summary,
								error: "Task session is not running.",
							};
						}
					} else if (step.type === "wait") {
						await delay(step.delayMs);
					}
				}
			} else {
				const payload = body.appendNewline ? `${body.text}\n` : body.text;
				const afterWrite = terminalManager.writeInput(body.taskId, Buffer.from(payload, "utf8"));
				if (afterWrite) {
					summary = afterWrite;
				} else {
					return {
						ok: false,
						summary: null,
						error: "Task session is not running.",
					};
				}
			}
			return {
				ok: true,
				summary,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				summary: null,
				error: message,
			};
		}
	};

	const notifyTaskReadyForReview: RuntimeTrpcContext["runtimeApi"]["notifyTaskReadyForReview"] = async (
		workspaceScope,
		input,
	): Promise<RuntimeTaskReviewNotificationResponse> => {
		try {
			const body = parseTaskReviewNotificationRequest(input);
			const state = await loadWorkspaceState(workspaceScope.workspacePath);
			const task =
				state.board.columns.flatMap((column) => column.cards).find((candidate) => candidate.id === body.taskId) ??
				null;
			if (!task) {
				return {
					ok: false,
					taskId: body.taskId,
					homeAgentTaskId: null,
					notified: false,
					message: null,
					error: `Task "${body.taskId}" was not found in workspace ${workspaceScope.workspacePath}.`,
				};
			}
			const taskSummary = state.sessions[body.taskId] ?? null;
			const reviewNotificationKey = buildTaskReviewNotificationKey({
				taskId: body.taskId,
				summary: taskSummary,
			});

			const workspaces = await listWorkspacesWithEpic();
			const architectWorkspaceId = resolveArchitectHomeAgentWorkspaceId(workspaces, workspaceScope.workspaceId);
			let architectWorkspaceScope: RuntimeTrpcWorkspaceScope;
			if (architectWorkspaceId === workspaceScope.workspaceId) {
				architectWorkspaceScope = workspaceScope;
			} else {
				const architectWorkspaceContext = await loadWorkspaceContextById(architectWorkspaceId);
				if (!architectWorkspaceContext) {
					return {
						ok: true,
						taskId: body.taskId,
						homeAgentTaskId: null,
						notified: false,
						message: null,
					};
				}
				architectWorkspaceScope = {
					workspaceId: architectWorkspaceContext.workspaceId,
					workspacePath: architectWorkspaceContext.repoPath,
				};
			}

			const homeAgentTaskId = resolveRunningHomeAgentTaskId({
				architectWorkspaceId,
				taskId: body.taskId,
			});

			if (!homeAgentTaskId) {
				return {
					ok: true,
					taskId: body.taskId,
					homeAgentTaskId: null,
					notified: false,
					message: null,
				};
			}
			if (hasReviewNotificationBeenSent({ taskId: body.taskId, summary: taskSummary })) {
				return {
					ok: true,
					taskId: body.taskId,
					homeAgentTaskId,
					notified: false,
					message: null,
				};
			}

			const message = buildTaskReadyForReviewMessage(task);
			const response = await sendTaskSessionInput(architectWorkspaceScope, {
				taskId: homeAgentTaskId,
				text: message,
				bracketedPaste: true,
				submit: true,
			});
			if (!response.ok) {
				return {
					ok: true,
					taskId: body.taskId,
					homeAgentTaskId,
					notified: false,
					message,
				};
			}
			await persistReviewNotificationKey(workspaceScope.workspacePath, body.taskId, reviewNotificationKey);
			return {
				ok: true,
				taskId: body.taskId,
				homeAgentTaskId,
				notified: true,
				message,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				taskId: typeof input === "object" && input !== null && "taskId" in input ? String(input.taskId) : "",
				homeAgentTaskId: null,
				notified: false,
				message: null,
				error: message,
			};
		}
	};

	return {
		loadConfig: async (workspaceScope) => {
			const activeRuntimeConfig = deps.getActiveRuntimeConfig?.();
			if (!workspaceScope && !activeRuntimeConfig) {
				throw new Error("No active runtime config provider is available.");
			}
			let scopedRuntimeConfig: RuntimeConfigState;
			if (workspaceScope) {
				scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
			} else if (activeRuntimeConfig) {
				scopedRuntimeConfig = activeRuntimeConfig;
			} else {
				throw new Error("No active runtime config provider is available.");
			}
			return buildConfigResponse(scopedRuntimeConfig);
		},
		saveConfig: async (workspaceScope, input) => {
			const parsed = parseRuntimeConfigSaveRequest(input);
			let nextRuntimeConfig: RuntimeConfigState;
			if (workspaceScope) {
				nextRuntimeConfig = await updateRuntimeConfig(workspaceScope.workspacePath, parsed);
			} else {
				const activeRuntimeConfig = deps.getActiveRuntimeConfig?.();
				if (!activeRuntimeConfig) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "No active runtime config is available.",
					});
				}
				nextRuntimeConfig = await updateGlobalRuntimeConfig(activeRuntimeConfig, parsed);
			}
			if (workspaceScope && workspaceScope.workspaceId === deps.getActiveWorkspaceId()) {
				deps.setActiveRuntimeConfig(nextRuntimeConfig);
			}
			if (!workspaceScope) {
				deps.setActiveRuntimeConfig(nextRuntimeConfig);
			}
			return buildConfigResponse(nextRuntimeConfig);
		},
		startTaskSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionStartRequest(input);
				if (body.resumeFromTrash) {
					deps.broadcastTaskChatCleared?.(workspaceScope.workspaceId, body.taskId);
				}
				const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
				// The home/workspace agent roots at its repo, but which repo's config it
				// loads depends on its role: the architect workspace (parent of other
				// registered repos) loads parent-level config; an impl workspace loads its
				// own. The same classification also seeds the architect's initial context
				// with awareness of the sub-repos it oversees (empty for everyone else).
				let architectContextPreamble = "";
				let fleetToolsWarning: string | null = null;
				let taskCwd: string;
				// The registered index drives doctrine scoping for both roles, so read it
				// once here (degrading to empty on failure) rather than in each branch.
				const listWorkspaces = deps.listWorkspaces ?? listWorkspacesWithEpic;
				const readDoctrineFile = deps.readDoctrineFile ?? readFileIfExists;
				let workspaceIndex: RegisteredWorkspace[];
				try {
					workspaceIndex = await listWorkspaces();
				} catch {
					workspaceIndex = [];
				}
				if (isHomeAgentSessionId(body.taskId)) {
					const homeAgentContext = await resolveHomeAgentContext({
						workspaceId: workspaceScope.workspaceId,
						workspacePath: workspaceScope.workspacePath,
						listWorkspaces: async () => workspaceIndex,
					});
					taskCwd = homeAgentContext.cwd;
					architectContextPreamble = homeAgentContext.architectContextPreamble;
					fleetToolsWarning = homeAgentContext.fleetToolsWarning;
				} else {
					taskCwd = await resolveExistingTaskCwdOrEnsure({
						cwd: workspaceScope.workspacePath,
						taskId: body.taskId,
						baseRef: body.baseRef,
					});
				}
				const shouldCaptureTurnCheckpoint = !body.resumeFromTrash && !isHomeAgentSessionId(body.taskId);
				const isHome = isHomeAgentSessionId(body.taskId);
				const skillName = body.skill?.trim();

				let withDirectives = body.prompt;

				if (isHome) {
					withDirectives = skillName
						? `Use the "${skillName}" skill for this task.\n\n---\n\n${body.prompt}`
						: body.prompt;
				} else if (skillName) {
					const directive = composeCardDirective([skillName], {
						baseRef: body.baseRef,
						workspacePath: workspaceScope.workspacePath,
					});
					const skillPrompt = `Use the "${skillName}" skill for this task.\n\n---\n\n${body.prompt}`;
					withDirectives = directive ? `${directive}${skillPrompt}` : skillPrompt;
				} else {
					let board = { columns: [] as any[] };
					let boardCardType: string | undefined;
					let boardAutoReviewEnabled: boolean | undefined;
					let boardAutoReviewMode: RuntimeTaskAutoReviewMode | undefined;

					try {
						const state = await loadWorkspaceState(workspaceScope.workspacePath);
						if (state?.board) {
							board = state.board;
							for (const column of board.columns) {
								const card = column.cards.find((c: any) => c.id === body.taskId);
								if (card) {
									boardCardType = card.cardType;
									boardAutoReviewEnabled = card.autoReviewEnabled;
									boardAutoReviewMode = card.autoReviewMode;
									break;
								}
							}
						}
					} catch {
						// Fallback safely when workspace state or git detection fails (e.g. in resume routing unit tests)
					}

					const cardType = body.cardType?.trim() || boardCardType?.trim() || "build";

					const manifest =
						(await loadCardTypeManifest(cardType, { workspacePath: workspaceScope.workspacePath })) ??
						(await loadCardTypeManifest("build", { workspacePath: workspaceScope.workspacePath }));

					if (manifest) {
						const autoReviewEnabled = body.autoReviewEnabled ?? boardAutoReviewEnabled ?? false;
						const autoReviewMode = body.autoReviewMode ?? boardAutoReviewMode;

						const orderedSkills = resolveStartActiveSkills(manifest, {
							autoReviewEnabled,
							autoReviewMode,
						});

						for (const skillName of orderedSkills) {
							const status = validateSkill(skillName, { workspacePath: workspaceScope.workspacePath });
							if (status !== "ok") {
								process.stderr.write(
									`[kanban] Warning: Skill "${skillName}" for card-type "${manifest.name}" is ${status}. It will be skipped.\n`,
								);
							}
						}

						const directive = composeCardDirective(orderedSkills, {
							baseRef: body.baseRef,
							workspacePath: workspaceScope.workspacePath,
						});
						withDirectives = directive ? `${directive}${body.prompt}` : body.prompt;
					}
				}

				// Prepend the repo's constitution to card prompts so it can't be skipped (Article 1/5).
				// Scoped via resolveDoctrineScope so an overseen repo resolves in-repo first, else
				// architect-owned doctrine at the fleet root; null when the repo has none, leaving the
				// prompt unchanged. The home/architect agent gets the constitution via its context
				// preamble instead, not prepended to every message.
				const doctrine = isHome
					? null
					: await loadDoctrine(
							{
								repoPath: workspaceScope.workspacePath,
								...resolveDoctrineScope(workspaceScope.workspacePath, workspaceIndex),
							},
							readDoctrineFile,
						);
				const finalPrompt = prependConstitution(withDirectives, doctrine?.constitution ?? null);

				// Surface a fleet-tools resolution failure to the user without blocking the
				// start: the architect still launches, but its board commands are unavailable.
				const applyFleetToolsWarning = <T extends { warningMessage?: string | null }>(summary: T): T =>
					fleetToolsWarning ? { ...summary, warningMessage: fleetToolsWarning } : summary;

				// Per-task config source-of-truth precedence:
				//
				// agentId resolution (which agent runtime to use):
				//   1. previousTerminalAgentId — persisted in the terminal session summary from
				//      the last run; ensures trash-restore resumes with the same agent runtime.
				//   2. body.agentId — the card's current per-task agent override.
				//   3. scopedRuntimeConfig.selectedAgentId — the workspace-level default.
				//
				// agentModel resolution:
				//   Always taken from the card's current override, so changing the card
				//   updates the next launch, including trash-restore.
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const previousTerminalAgentId = body.resumeFromTrash
					? (terminalManager.getSummary(body.taskId)?.agentId ?? null)
					: null;
				const effectiveAgentId = previousTerminalAgentId ?? body.agentId ?? scopedRuntimeConfig.selectedAgentId;

				const resolvedConfig =
					effectiveAgentId !== scopedRuntimeConfig.selectedAgentId
						? { ...scopedRuntimeConfig, selectedAgentId: effectiveAgentId }
						: scopedRuntimeConfig;
				const resolved = resolveAgentCommand(resolvedConfig);
				if (!resolved) {
					return {
						ok: false,
						summary: null,
						error: "No runnable agent command is configured. Open Settings, install a supported CLI, and select it.",
					};
				}
				const previousSummary =
					typeof terminalManager.refreshAgentSessionLifecycle === "function"
						? await terminalManager.refreshAgentSessionLifecycle(body.taskId)
						: typeof terminalManager.getSummary === "function"
							? terminalManager.getSummary(body.taskId)
							: null;
				const resumeMode =
					body.resumeMode ?? (previousSummary?.agentSessionLifecycle === "resumable" ? "resume" : undefined);
				const summary = await terminalManager.startTaskSession({
					taskId: body.taskId,
					agentId: resolved.agentId,
					binary: resolved.binary,
					args: resolved.args,
					autonomousModeEnabled: scopedRuntimeConfig.agentAutonomousModeEnabled,
					cwd: taskCwd,
					prompt: finalPrompt,
					agentModel: body.agentModel,
					images: body.images,
					resumeFromTrash: body.resumeFromTrash,
					resumeMode,
					cols: body.cols,
					rows: body.rows,
					workspaceId: workspaceScope.workspaceId,
					architectContextPreamble,
				});

				let nextSummary = summary;
				if (shouldCaptureTurnCheckpoint && summary.pid !== null) {
					try {
						const nextTurn = (summary.latestTurnCheckpoint?.turn ?? 0) + 1;
						const checkpoint = await captureTaskTurnCheckpoint({
							cwd: taskCwd,
							taskId: body.taskId,
							turn: nextTurn,
						});
						nextSummary = terminalManager.applyTurnCheckpoint(body.taskId, checkpoint) ?? summary;
					} catch {
						// Best effort checkpointing only.
					}
				}
				const responseSummary = applyFleetToolsWarning(nextSummary);
				// Persist for cards and overseers alike. An agent that mints its own session id
				// only reveals it after booting; that later id is written back by the runtime
				// state hub, which already owns a lifetime-managed subscription to session
				// summaries. Do not subscribe per request here.
				await persistTaskSessionSummary(workspaceScope.workspacePath, responseSummary);

				return {
					ok: true,
					summary: responseSummary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		stopTaskSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionStopRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = terminalManager.stopTaskSession(body.taskId);
				return {
					ok: Boolean(summary),
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		startFreshHomeAgentSession: async (workspaceScope, input) => {
			try {
				const body = parseHomeAgentFreshStartRequest(input);
				if (!isHomeAgentSessionId(body.taskId)) {
					return {
						ok: false,
						summary: null,
						error: "Only home agent sessions can be started fresh.",
					};
				}
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = terminalManager.startFreshHomeAgentSession(body.taskId);
				await persistTaskSessionSummary(workspaceScope.workspacePath, summary);
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		sendTaskSessionInput,
		notifyTaskReadyForReview,
		getTaskChatMessages: async (_workspaceScope, input) => {
			try {
				parseTaskTranscriptRequest(input);
				return {
					ok: false,
					messages: [],
					error: "Task chat session is not available.",
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					messages: [],
					error: message,
				};
			}
		},
		getTaskTranscript: async (workspaceScope, input) => {
			try {
				const body = parseTaskTranscriptRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = terminalManager.getSummary(body.taskId);
				if (!summary?.agentId || !summary.agentSessionId) {
					// No captured CLI session id → nothing durable to read back.
					return { ok: true, present: false, messages: [] };
				}
				const transcript = await readAgentTranscript({
					agentId: summary.agentId,
					sessionId: summary.agentSessionId,
					homePath: homedir(),
				});
				return {
					ok: true,
					present: transcript.present,
					messages: transcript.messages,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, present: false, messages: [], error: message };
			}
		},
		getTaskTokenUsage: async (workspaceScope, input) => {
			try {
				const body = parseTaskTokenUsageRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const usage: Record<string, RuntimeTaskTokenUsage | null> = {};
				// Derive per card, tolerantly: a card with no captured session, or
				// whose transcript is gone/empty, contributes a `null` entry rather
				// than failing the whole batch. Callers get one entry per requested id.
				await Promise.all(
					body.taskIds.map(async (taskId) => {
						const summary = terminalManager.getSummary(taskId);
						if (!summary?.agentId || !summary.agentSessionId) {
							usage[taskId] = null;
							return;
						}
						const result = await readAgentUsage({
							agentId: summary.agentId,
							sessionId: summary.agentSessionId,
							homePath: homedir(),
						});
						usage[taskId] = result.usage;
					}),
				);
				return { ok: true, usage };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, usage: {}, error: message };
			}
		},
		reloadTaskChatSession: async (_workspaceScope, input) => {
			try {
				parseTaskTranscriptRequest(input);
				return {
					ok: false,
					summary: null,
					error: "Task chat session is not available.",
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		abortTaskChatTurn: async (_workspaceScope, input) => {
			try {
				parseTaskTranscriptRequest(input);
				return {
					ok: false,
					summary: null,
					error: "Task chat session is not running.",
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		cancelTaskChatTurn: async (_workspaceScope, input) => {
			try {
				parseTaskTranscriptRequest(input);
				return {
					ok: false,
					summary: null,
					error: "Task chat session turn is not running.",
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		getFeaturebaseToken: async (_workspaceScope) => {
			return { featurebaseJwt: "" };
		},
		getAgentBudget: async (_workspaceScope) => {
			return await getAgentBudget();
		},
		getFleetUpdateStatus: async (_workspaceScope) => {
			const [status, inProgressCount] = await Promise.all([
				getFleetUpdateStatus(),
				deps.getFleetUpdateInProgressCount(),
			]);
			return { status, inProgressCount };
		},
		applyFleetUpdate: async (_workspaceScope) => {
			const inProgressCount = await deps.getFleetUpdateInProgressCount();
			return await applyFleetUpdate({ inProgressCount });
		},
		sendTaskChatMessage: async (_workspaceScope, input) => {
			try {
				parseTaskTranscriptRequest(input);
				return {
					ok: false,
					summary: null,
					error: "Task chat session is not running.",
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		startShellSession: async (workspaceScope, input) => {
			try {
				const body = parseShellSessionStartRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const shell = deps.resolveInteractiveShellCommand();
				const shellCwd = body.workspaceTaskId
					? await resolveTaskCwd({
							cwd: workspaceScope.workspacePath,
							taskId: body.workspaceTaskId,
							baseRef: body.baseRef,
							ensure: true,
						})
					: workspaceScope.workspacePath;
				const summary = await terminalManager.startShellSession({
					taskId: body.taskId,
					cwd: shellCwd,
					cols: body.cols,
					rows: body.rows,
					binary: shell.binary,
					args: shell.args,
				});
				return {
					ok: true,
					summary,
					shellBinary: shell.binary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					shellBinary: null,
					error: message,
				};
			}
		},
		runCommand: async (workspaceScope, input) => {
			try {
				const body = parseCommandRunRequest(input);
				return await deps.runCommand(body.command, workspaceScope.workspacePath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message,
				});
			}
		},
		resetAllState: async (_workspaceScope) => {
			await deps.prepareForStateReset?.();
			await Promise.all(
				debugResetTargetPaths.map(async (path) => {
					await rm(path, { recursive: true, force: true });
				}),
			);
			return {
				ok: true,
				clearedPaths: [...debugResetTargetPaths],
			};
		},
		openFile: async (input) => {
			const filePath = input.filePath.trim();
			if (!filePath) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "File path cannot be empty.",
				});
			}
			openInBrowser(filePath);
			return { ok: true };
		},
		getUpdateStatus: async () => {
			return deps.getUpdateStatus();
		},
		runUpdateNow: async () => {
			return await deps.runUpdateNow();
		},
	};
}
