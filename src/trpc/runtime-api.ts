// Coordinates the runtime-side TRPC handlers used by the browser.
// This is the main backend entrypoint for sessions, settings, git, and
// workspace actions, but detailed Cline, terminal, and config behavior
// should stay in focused services instead of accumulating here.

import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { createClineMcpRuntimeService } from "../cline-sdk/cline-mcp-runtime-service";
import { createClineMcpSettingsService } from "../cline-sdk/cline-mcp-settings-service";
import { createClineProviderService } from "../cline-sdk/cline-provider-service";
import { isClineClearSlashCommand } from "../cline-sdk/cline-slash-commands";
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import { clineHomeDir } from "../config/cline-home";
import type { RuntimeConfigState } from "../config/runtime-config";
import { updateGlobalRuntimeConfig, updateRuntimeConfig } from "../config/runtime-config";
import type {
	RuntimeCommandRunResponse,
	RuntimeRunUpdateResponse,
	RuntimeTaskReviewNotificationResponse,
	RuntimeTaskTokenUsage,
	RuntimeUpdateStatusResponse,
} from "../core/api-contract";
import {
	parseClineAccountSwitchRequest,
	parseClineAddProviderRequest,
	parseClineDeviceAuthCompleteRequest,
	parseClineMcpOAuthRequest,
	parseClineMcpSettingsSaveRequest,
	parseClineOauthLoginRequest,
	parseClineProviderModelsRequest,
	parseClineProviderSettingsSaveRequest,
	parseClineUpdateProviderRequest,
	parseCommandRunRequest,
	parseRuntimeConfigSaveRequest,
	parseShellSessionStartRequest,
	parseTaskChatAbortRequest,
	parseTaskChatCancelRequest,
	parseTaskChatMessagesRequest,
	parseTaskChatReloadRequest,
	parseTaskChatSendRequest,
	parseTaskReviewNotificationRequest,
	parseTaskSessionInputRequest,
	parseTaskSessionStartRequest,
	parseTaskSessionStopRequest,
	parseTaskTokenUsageRequest,
	parseTaskTranscriptRequest,
} from "../core/api-validation";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { buildTaskReadyForReviewMessage, resolveRunningHomeAgentTaskId } from "../core/review-notification";
import { resolveTaskTitle } from "../core/task-title.js";
import { readFileIfExists } from "../fs/read-file-if-exists";
import { loadDoctrine, prependConstitution, type ReadFileIfExists } from "../prompts/doctrine";
import { prependImplementCardDirective } from "../prompts/implement-card-directive";
import { prependPrCardDirective } from "../prompts/pr-card-directive";
import { resolveHomeAgentContext } from "../server/architect-workspace";
import { openInBrowser } from "../server/browser";
import { listWorkspaceIndexEntries, loadWorkspaceState } from "../state/workspace-state";
import { buildRuntimeConfigResponse, resolveAgentCommand } from "../terminal/agent-registry";
import { toBracketedPasteSubmission } from "../terminal/agent-session-adapters";
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
	getScopedClineTaskSessionService: (scope: RuntimeTrpcWorkspaceScope) => Promise<ClineTaskSessionService>;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	runCommand: (command: string, cwd: string) => Promise<RuntimeCommandRunResponse>;
	/** Reads a doctrine file (constitution) for prompt injection; defaults to the real filesystem. */
	readDoctrineFile?: ReadFileIfExists;
	broadcastClineMcpAuthStatusesUpdated?: (
		statuses: Awaited<ReturnType<ReturnType<typeof createClineMcpRuntimeService>["getAuthStatuses"]>>,
	) => void;
	broadcastTaskChatCleared?: (workspaceId: string, taskId: string) => void;
	bumpClineSessionContextVersion?: () => void;
	prepareForStateReset?: () => Promise<void>;
	getUpdateStatus: () => RuntimeUpdateStatusResponse;
	runUpdateNow: () => Promise<RuntimeRunUpdateResponse>;
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

export function createRuntimeApi(deps: CreateRuntimeApiDependencies): RuntimeTrpcContext["runtimeApi"] {
	const clineProviderService = createClineProviderService();
	const clineMcpSettingsService = createClineMcpSettingsService();
	const clineMcpRuntimeService = createClineMcpRuntimeService({
		onAuthStatusesChanged: (statuses) => {
			deps.broadcastClineMcpAuthStatusesUpdated?.(statuses);
		},
	});
	const debugResetTargetPaths = [
		join(clineHomeDir(), "data"),
		join(clineHomeDir(), "kanban"),
		join(clineHomeDir(), "worktrees"),
	] as const;

	const buildConfigResponse = (runtimeConfig: RuntimeConfigState) =>
		buildRuntimeConfigResponse(runtimeConfig, clineProviderService.getProviderSettingsSummary());

	const sendTaskSessionInput: RuntimeTrpcContext["runtimeApi"]["sendTaskSessionInput"] = async (
		workspaceScope,
		input,
	) => {
		try {
			const body = parseTaskSessionInputRequest(input);
			// Cline sessions accept input as a discrete message, so bracketed-paste
			// framing (a PTY concern) doesn't apply — send the plain text.
			const clineText = body.appendNewline ? `${body.text}\n` : body.text;
			const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
			const clineSummary = await clineTaskSessionService.sendTaskSessionInput(body.taskId, clineText);
			if (clineSummary) {
				return {
					ok: true,
					summary: clineSummary,
				};
			}
			// PTY path: `fleet task say` wraps steering in a bracketed paste so a
			// mid-turn agent buffers it cleanly; `submit` decides whether it's sent.
			const wantsSubmit = body.submit ?? true;
			// Write the bracketed paste WITHOUT a trailing Enter. Claude's Ink TUI
			// treats a carriage return fused onto the paste-end marker (…[201~\r)
			// as buffered text, not a submit — so the steer text lands but never sends.
			const ptyPayload = body.bracketedPaste
				? toBracketedPasteSubmission(body.text, false)
				: body.appendNewline
					? `${body.text}\n`
					: body.text;
			const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
			let summary = terminalManager.writeInput(body.taskId, Buffer.from(ptyPayload, "utf8"));
			if (!summary) {
				return {
					ok: false,
					summary: null,
					error: "Task session is not running.",
				};
			}
			// Send the Enter as a SEPARATE write so paste-mode has closed and the
			// carriage return registers as a submit keypress. `--no-submit` skips this,
			// leaving the text staged in the prompt.
			if (body.bracketedPaste && wantsSubmit) {
				const afterSubmit = terminalManager.writeInput(body.taskId, Buffer.from("\r", "utf8"));
				if (afterSubmit) {
					summary = afterSubmit;
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

			const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
			const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
			const homeAgentTaskId = resolveRunningHomeAgentTaskId({
				workspaceId: workspaceScope.workspaceId,
				taskId: body.taskId,
				summaries: [...clineTaskSessionService.listSummaries(), ...terminalManager.listSummaries()],
				isActive: (taskId) =>
					clineTaskSessionService.hasActiveTaskSession(taskId) || terminalManager.getSummary(taskId)?.pid != null,
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

			const message = buildTaskReadyForReviewMessage(task);
			const response = await sendTaskSessionInput(workspaceScope, {
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
		saveClineProviderSettings: async (_workspaceScope, input) => {
			const body = parseClineProviderSettingsSaveRequest(input);
			const response = clineProviderService.saveProviderSettings(body);
			deps.bumpClineSessionContextVersion?.();
			return response;
		},
		addClineProvider: async (_workspaceScope, input) => {
			const body = parseClineAddProviderRequest(input);
			const response = await clineProviderService.addCustomProvider(body);
			deps.bumpClineSessionContextVersion?.();
			return response;
		},
		updateClineProvider: async (_workspaceScope, input) => {
			const body = parseClineUpdateProviderRequest(input);
			const response = await clineProviderService.updateCustomProvider(body);
			deps.bumpClineSessionContextVersion?.();
			return response;
		},
		startTaskSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionStartRequest(input);
				if (body.resumeFromTrash) {
					deps.broadcastTaskChatCleared?.(workspaceScope.workspaceId, body.taskId);
				}
				const requestedClineTaskMode = body.mode ?? "act";
				const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
				// The home/workspace agent roots at its repo, but which repo's config it
				// loads depends on its role: the architect workspace (parent of other
				// registered repos) loads parent-level config; an impl workspace loads its
				// own. The same classification also seeds the architect's initial context
				// with awareness of the sub-repos it oversees (empty for everyone else).
				let architectContextPreamble = "";
				let fleetToolsWarning: string | null = null;
				let taskCwd: string;
				if (isHomeAgentSessionId(body.taskId)) {
					const homeAgentContext = await resolveHomeAgentContext({
						workspaceId: workspaceScope.workspaceId,
						workspacePath: workspaceScope.workspacePath,
						listWorkspaces: listWorkspaceIndexEntries,
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
				const skillName = body.skill?.trim();
				const skillPrompt = skillName
					? `Use the "${skillName}" skill for this task.\n\n---\n\n${body.prompt}`
					: body.prompt;
				const withPrDirective = prependPrCardDirective(skillPrompt, body.autoReviewEnabled, body.autoReviewMode);
				// A build card with no explicit skill defaults to fleet-implement (skipped for plan
				// cards and the home agent — see prependImplementCardDirective). An explicit `skill:`
				// overrides that default rather than stacking on top of it.
				const withDirectives = skillName
					? withPrDirective
					: prependImplementCardDirective(withPrDirective, body.taskId, body.startInPlanMode);
				// Prepend the repo's constitution to card prompts so it can't be skipped (Article 1/5).
				// Resolved in-repo first, else from architect-owned doctrine at the fleet root; null when
				// the repo has none, in which case the prompt is unchanged. The home/architect agent gets
				// the constitution via its context preamble instead, not prepended to every message.
				const doctrine = isHomeAgentSessionId(body.taskId)
					? null
					: await loadDoctrine(
							{ repoPath: workspaceScope.workspacePath },
							deps.readDoctrineFile ?? readFileIfExists,
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
				// clineSettings (which LLM model and reasoning profile the Cline agent uses):
				//   Always taken from the card's current override object. There is no
				//   session-level persistence for these;
				//   if the user changes the model on the card, the next session launch
				//   (including trash-restore) uses the updated values.
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const previousTerminalAgentId = body.resumeFromTrash
					? (terminalManager.getSummary(body.taskId)?.agentId ?? null)
					: null;
				const effectiveAgentId = previousTerminalAgentId ?? body.agentId ?? scopedRuntimeConfig.selectedAgentId;
				let useClinePath = effectiveAgentId === "cline";
				const shouldProbePersistedClineSession =
					body.resumeFromTrash && !useClinePath && previousTerminalAgentId === null;
				if (shouldProbePersistedClineSession) {
					// If the terminal summary already has a concrete non-Cline agentId,
					// skip Cline persisted-session probing. That probe can cold-start the
					// Cline session host and adds multi-second latency to Codex restores.
					const clineSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
					const persistedSession = await clineSessionService
						.rebindPersistedTaskSession(body.taskId)
						.catch(() => null);
					if (persistedSession) {
						useClinePath = true;
					}
				}

				if (useClinePath) {
					const hasTaskLevelClineSettingsOverride = body.clineSettings !== undefined;
					const clineLaunchConfig = await clineProviderService.resolveLaunchConfig({
						providerIdOverride: body.clineSettings?.providerId ?? undefined,
						modelIdOverride: body.clineSettings?.modelId ?? undefined,
						...(hasTaskLevelClineSettingsOverride
							? {
									reasoningEffortOverride: body.clineSettings?.reasoningEffort ?? null,
								}
							: {}),
					});
					const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
					const resolvedClineTitle = resolveTaskTitle(body.taskTitle?.trim(), body.prompt);
					const summary = await clineTaskSessionService.startTaskSession({
						taskId: body.taskId,
						cwd: taskCwd,
						prompt: finalPrompt,
						taskTitle: resolvedClineTitle.length > 0 ? resolvedClineTitle : undefined,
						images: body.images,
						resumeFromTrash: body.resumeFromTrash,
						resumeFromPersistence: body.resumeMode === "resume",
						providerId: clineLaunchConfig.providerId,
						modelId: clineLaunchConfig.modelId,
						mode: requestedClineTaskMode,
						startInPlanMode: body.startInPlanMode,
						apiKey: clineLaunchConfig.apiKey,
						baseUrl: clineLaunchConfig.baseUrl,
						reasoningEffort: clineLaunchConfig.reasoningEffort,
						architectContextPreamble,
					});

					let nextSummary = summary;
					if (shouldCaptureTurnCheckpoint) {
						try {
							const nextTurn = (summary.latestTurnCheckpoint?.turn ?? 0) + 1;
							const checkpoint = await captureTaskTurnCheckpoint({
								cwd: taskCwd,
								taskId: body.taskId,
								turn: nextTurn,
							});
							nextSummary = clineTaskSessionService.applyTurnCheckpoint(body.taskId, checkpoint) ?? summary;
						} catch {
							// Best effort checkpointing only.
						}
					}

					return {
						ok: true,
						summary: applyFleetToolsWarning(nextSummary),
					};
				}

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
					startInPlanMode: body.startInPlanMode,
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
				return {
					ok: true,
					summary: applyFleetToolsWarning(nextSummary),
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
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const clineSummary = await clineTaskSessionService.stopTaskSession(body.taskId);
				if (clineSummary) {
					return {
						ok: true,
						summary: clineSummary,
					};
				}
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
		sendTaskSessionInput,
		notifyTaskReadyForReview,
		getTaskChatMessages: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatMessagesRequest(input);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const summary = clineTaskSessionService.getSummary(body.taskId);
				const messages = await clineTaskSessionService.loadTaskSessionMessages(body.taskId);
				if (!summary && messages.length === 0) {
					return {
						ok: false,
						messages: [],
						error: "Task chat session is not available.",
					};
				}
				return {
					ok: true,
					messages,
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
		getClineSlashCommands: async (workspaceScope) => {
			if (!workspaceScope) {
				return {
					commands: [],
				};
			}
			const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
			return {
				commands: await clineTaskSessionService.listSlashCommands(workspaceScope.workspacePath),
			};
		},
		reloadTaskChatSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatReloadRequest(input);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				let summary = await clineTaskSessionService.reloadTaskSession(body.taskId);
				if (!summary && isHomeAgentSessionId(body.taskId)) {
					const clineLaunchConfig = await clineProviderService.resolveLaunchConfig();
					summary = await clineTaskSessionService.startTaskSession({
						taskId: body.taskId,
						cwd: workspaceScope.workspacePath,
						prompt: "",
						resumeFromPersistence: true,
						providerId: clineLaunchConfig.providerId,
						modelId: clineLaunchConfig.modelId,
						apiKey: clineLaunchConfig.apiKey,
						baseUrl: clineLaunchConfig.baseUrl,
						reasoningEffort: clineLaunchConfig.reasoningEffort,
					});
				}
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task chat session is not available.",
					};
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
		},
		abortTaskChatTurn: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatAbortRequest(input);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const summary = await clineTaskSessionService.abortTaskSession(body.taskId);
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task chat session is not running.",
					};
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
		},
		cancelTaskChatTurn: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatCancelRequest(input);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const summary = await clineTaskSessionService.cancelTaskTurn(body.taskId);
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task chat session turn is not running.",
					};
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
		},
		getClineProviderCatalog: async (_workspaceScope) => {
			return await clineProviderService.getProviderCatalog();
		},
		getClineAccountProfile: async (_workspaceScope) => {
			return await clineProviderService.getClineAccountProfile();
		},
		getClineKanbanAccess: async (_workspaceScope) => {
			return await clineProviderService.getClineKanbanAccess();
		},
		getFeaturebaseToken: async (_workspaceScope) => {
			return await clineProviderService.getFeaturebaseToken();
		},
		getClineAccountBalance: async (_workspaceScope) => {
			return await clineProviderService.getClineAccountBalance();
		},
		getClineAccountOrganizations: async (_workspaceScope) => {
			return await clineProviderService.getClineAccountOrganizations();
		},
		switchClineAccount: async (_workspaceScope, input) => {
			const body = parseClineAccountSwitchRequest(input);
			return await clineProviderService.switchClineAccount(body.organizationId);
		},
		getClineProviderModels: async (_workspaceScope, input) => {
			const body = parseClineProviderModelsRequest(input);
			return await clineProviderService.getProviderModels(body.providerId);
		},
		getClineMcpAuthStatuses: async (_workspaceScope) => {
			const statuses = await clineMcpRuntimeService.getAuthStatuses();
			return {
				statuses,
			};
		},
		runClineMcpServerOAuth: async (_workspaceScope, input) => {
			const body = parseClineMcpOAuthRequest(input);
			const response = await clineMcpRuntimeService.authorizeServer({
				serverName: body.serverName,
				onAuthorizationUrl: (url: string) => {
					openInBrowser(url);
				},
			});
			deps.bumpClineSessionContextVersion?.();
			return response;
		},
		getClineMcpSettings: async (_workspaceScope) => {
			return clineMcpSettingsService.loadSettings();
		},
		saveClineMcpSettings: async (_workspaceScope, input) => {
			const body = parseClineMcpSettingsSaveRequest(input);
			const response = await clineMcpSettingsService.saveSettings(body);
			deps.bumpClineSessionContextVersion?.();
			return response;
		},
		runClineProviderOAuthLogin: async (_workspaceScope, input) => {
			const body = parseClineOauthLoginRequest(input);
			const response = await clineProviderService.runOauthLogin({
				providerId: body.provider,
				baseUrl: body.baseUrl,
			});
			if (response.ok) {
				deps.bumpClineSessionContextVersion?.();
			}
			return response;
		},
		startClineDeviceAuth: async () => {
			return await clineProviderService.startDeviceAuth();
		},
		completeClineDeviceAuth: async (_workspaceScope, input) => {
			const body = parseClineDeviceAuthCompleteRequest(input);
			const response = await clineProviderService.completeDeviceAuth({
				deviceCode: body.deviceCode,
				expiresInSeconds: body.expiresInSeconds,
				pollIntervalSeconds: body.pollIntervalSeconds,
				baseUrl: body.baseUrl,
			});
			if (response.ok) {
				deps.bumpClineSessionContextVersion?.();
			}
			return response;
		},
		sendTaskChatMessage: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatSendRequest(input);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				if (isClineClearSlashCommand(body.text)) {
					const summary = await clineTaskSessionService.clearTaskSession(body.taskId);
					deps.broadcastTaskChatCleared?.(workspaceScope.workspaceId, body.taskId);
					return {
						ok: true,
						summary,
						message: null,
					};
				}
				const requestedMode = body.mode;
				let summary = await clineTaskSessionService.sendTaskSessionInput(
					body.taskId,
					body.text,
					requestedMode,
					body.images,
				);
				if (!summary) {
					if (!isHomeAgentSessionId(body.taskId)) {
						const reboundSummary = await clineTaskSessionService.rebindPersistedTaskSession(body.taskId);
						if (reboundSummary) {
							summary = await clineTaskSessionService.sendTaskSessionInput(
								body.taskId,
								body.text,
								requestedMode,
								body.images,
							);
						}
						if (!summary) {
							return {
								ok: false,
								summary: null,
								error: "Task chat session is not running.",
							};
						}
					} else {
						const clineLaunchConfig = await clineProviderService.resolveLaunchConfig();
						summary = await clineTaskSessionService.startTaskSession({
							taskId: body.taskId,
							cwd: workspaceScope.workspacePath,
							prompt: body.text,
							images: body.images,
							resumeFromPersistence: true,
							providerId: clineLaunchConfig.providerId,
							modelId: clineLaunchConfig.modelId,
							mode: requestedMode,
							apiKey: clineLaunchConfig.apiKey,
							baseUrl: clineLaunchConfig.baseUrl,
							reasoningEffort: clineLaunchConfig.reasoningEffort,
						});
					}
				}
				const latestMessage = clineTaskSessionService.listMessages(body.taskId).at(-1) ?? null;
				return {
					ok: true,
					summary,
					message: latestMessage,
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
