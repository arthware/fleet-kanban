// Manages the synthetic home agent session lifecycle for the sidebar.
// It keeps one derived session identity stable per architect workspace and
// reloads/restarts that identity in place when the selected agent configuration changes.

import { createHomeAgentSessionId } from "@runtime-home-agent-session";
import { useEffect, useMemo, useRef } from "react";

import { notifyError, showAppToast } from "@/components/app-toaster";
import { estimateTaskSessionGeometry } from "@/runtime/task-session-geometry";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeConfigResponse, RuntimeGitRepositoryInfo, RuntimeTaskSessionSummary } from "@/runtime/types";

type HomeAgentPanelMode = "terminal";

interface HomeAgentDescriptor {
	panelMode: HomeAgentPanelMode;
	taskId: string;
}

interface UseHomeAgentSessionInput {
	currentProjectId: string | null;
	runtimeProjectConfig: RuntimeConfigResponse | null;
	workspaceGit: RuntimeGitRepositoryInfo | null;
	upsertSessionSummary: (summary: RuntimeTaskSessionSummary) => void;
	startFreshSessionNonce?: number;
}

interface UseHomeAgentSessionResult {
	panelMode: HomeAgentPanelMode | null;
	taskId: string | null;
}

interface HomeAgentSessionIdentity {
	workspaceId: string;
	taskId: string;
}

function resolveHomeAgentBaseRef(workspaceGit: RuntimeGitRepositoryInfo | null): string {
	return workspaceGit?.currentBranch ?? workspaceGit?.defaultBranch ?? "HEAD";
}

function buildHomeAgentSessionKey(session: HomeAgentSessionIdentity): string {
	return `${session.workspaceId}:${session.taskId}`;
}

async function stopHomeAgentSession(session: HomeAgentSessionIdentity | null): Promise<void> {
	if (!session) {
		return;
	}
	try {
		await getRuntimeTrpcClient(session.workspaceId).runtime.stopTaskSession.mutate({
			taskId: session.taskId,
		});
	} catch {
		// Ignore stop errors during cleanup.
	}
}

export function useHomeAgentSession({
	currentProjectId,
	runtimeProjectConfig,
	workspaceGit,
	upsertSessionSummary,
	startFreshSessionNonce = 0,
}: UseHomeAgentSessionInput): UseHomeAgentSessionResult {
	const latestBaseRefRef = useRef("HEAD");
	const desiredTaskIdByWorkspaceRef = useRef(new Map<string, string>());
	const startedSessionKeysRef = useRef(new Set<string>());
	const pendingStartRequestIdsRef = useRef(new Map<string, number>());
	const previousTerminalConfigByWorkspaceRef = useRef(new Map<string, RuntimeConfigResponse>());
	const previousFreshStartNonceByWorkspaceRef = useRef(new Map<string, number>());
	const nextStartRequestIdRef = useRef(0);
	const disposedRef = useRef(false);

	useEffect(() => {
		latestBaseRefRef.current = resolveHomeAgentBaseRef(workspaceGit);
	}, [workspaceGit?.currentBranch, workspaceGit?.defaultBranch]);

	const descriptor = useMemo<HomeAgentDescriptor | null>(() => {
		if (!currentProjectId || !runtimeProjectConfig) {
			return null;
		}

		if (!runtimeProjectConfig.effectiveCommand) {
			return null;
		}

		const taskId = createHomeAgentSessionId(currentProjectId, runtimeProjectConfig.selectedAgentId);
		return {
			panelMode: "terminal",
			taskId,
		};
	}, [currentProjectId, runtimeProjectConfig]);

	const descriptorTaskId = descriptor?.taskId ?? null;
	const hasLoadedRuntimeProjectConfig = runtimeProjectConfig !== null;

	useEffect(() => {
		if (!currentProjectId || !hasLoadedRuntimeProjectConfig) {
			return;
		}

		const previousTaskId = desiredTaskIdByWorkspaceRef.current.get(currentProjectId) ?? null;

		if (!descriptorTaskId) {
			if (!previousTaskId) {
				return;
			}

			desiredTaskIdByWorkspaceRef.current.delete(currentProjectId);
			startedSessionKeysRef.current.delete(
				buildHomeAgentSessionKey({
					workspaceId: currentProjectId,
					taskId: previousTaskId,
				}),
			);
			void stopHomeAgentSession({
				workspaceId: currentProjectId,
				taskId: previousTaskId,
			});
			return;
		}

		if (previousTaskId === descriptorTaskId) {
			return;
		}

		desiredTaskIdByWorkspaceRef.current.set(currentProjectId, descriptorTaskId);

		if (!previousTaskId) {
			return;
		}

		startedSessionKeysRef.current.delete(
			buildHomeAgentSessionKey({
				workspaceId: currentProjectId,
				taskId: previousTaskId,
			}),
		);
		void stopHomeAgentSession({
			workspaceId: currentProjectId,
			taskId: previousTaskId,
		});
	}, [currentProjectId, descriptorTaskId, hasLoadedRuntimeProjectConfig]);

	// The terminal home-agent identity no longer rotates on an agent/command change
	// (the task id is derived, not suffixed with the agent). Reload it in place:
	// clear the started/pending bookkeeping so the start effect relaunches the same
	// task id with the fresh config, without tearing down the sidebar session entry.
	useEffect(() => {
		if (!currentProjectId || !descriptor || descriptor.panelMode !== "terminal" || !runtimeProjectConfig) {
			return;
		}

		const previousConfig = previousTerminalConfigByWorkspaceRef.current.get(currentProjectId);
		previousTerminalConfigByWorkspaceRef.current.set(currentProjectId, runtimeProjectConfig);
		if (
			previousConfig === undefined ||
			(previousConfig.selectedAgentId === runtimeProjectConfig.selectedAgentId &&
				previousConfig.effectiveCommand === runtimeProjectConfig.effectiveCommand)
		) {
			return;
		}

		const session = {
			workspaceId: currentProjectId,
			taskId: descriptor.taskId,
		} satisfies HomeAgentSessionIdentity;
		startedSessionKeysRef.current.delete(buildHomeAgentSessionKey(session));
		pendingStartRequestIdsRef.current.delete(buildHomeAgentSessionKey(session));
	}, [currentProjectId, descriptor, runtimeProjectConfig]);

	useEffect(() => {
		if (!currentProjectId || !descriptor || startFreshSessionNonce <= 0) {
			return;
		}
		const previousNonce = previousFreshStartNonceByWorkspaceRef.current.get(currentProjectId) ?? 0;
		previousFreshStartNonceByWorkspaceRef.current.set(currentProjectId, startFreshSessionNonce);
		if (previousNonce === startFreshSessionNonce) {
			return;
		}

		const session = {
			workspaceId: currentProjectId,
			taskId: descriptor.taskId,
		} satisfies HomeAgentSessionIdentity;
		const sessionKey = buildHomeAgentSessionKey(session);
		startedSessionKeysRef.current.delete(sessionKey);
		pendingStartRequestIdsRef.current.delete(sessionKey);

		let cancelled = false;
		void getRuntimeTrpcClient(currentProjectId)
			.runtime.startFreshHomeAgentSession.mutate({
				taskId: descriptor.taskId,
			})
			.then((response) => {
				if (cancelled || disposedRef.current) {
					return;
				}
				if (!response.ok || !response.summary) {
					throw new Error(response.error ?? "Could not start a fresh home agent session.");
				}
				upsertSessionSummary(response.summary);
			})
			.catch((error) => {
				if (cancelled || disposedRef.current) {
					return;
				}
				const message = error instanceof Error ? error.message : String(error);
				notifyError(message);
			});

		return () => {
			cancelled = true;
		};
	}, [currentProjectId, descriptor, startFreshSessionNonce, upsertSessionSummary]);

	useEffect(() => {
		if (!currentProjectId || !descriptor || descriptor.panelMode !== "terminal") {
			return;
		}

		const session = {
			workspaceId: currentProjectId,
			taskId: descriptor.taskId,
		} satisfies HomeAgentSessionIdentity;
		const sessionKey = buildHomeAgentSessionKey(session);

		if (desiredTaskIdByWorkspaceRef.current.get(session.workspaceId) !== session.taskId) {
			return;
		}

		if (startedSessionKeysRef.current.has(sessionKey)) {
			return;
		}

		if (pendingStartRequestIdsRef.current.has(sessionKey)) {
			return;
		}

		const requestId = nextStartRequestIdRef.current + 1;
		nextStartRequestIdRef.current = requestId;
		pendingStartRequestIdsRef.current.set(sessionKey, requestId);

		void (async () => {
			try {
				const geometry = estimateTaskSessionGeometry(window.innerWidth, window.innerHeight);
				const trpcClient = getRuntimeTrpcClient(session.workspaceId);
				const response = await trpcClient.runtime.startTaskSession.mutate({
					taskId: session.taskId,
					prompt: "",
					baseRef: latestBaseRefRef.current,
					cols: geometry.cols,
					rows: geometry.rows,
				});

				if (!response.ok || !response.summary) {
					throw new Error(response.error ?? "Could not start home agent session.");
				}

				if (pendingStartRequestIdsRef.current.get(sessionKey) !== requestId) {
					return;
				}
				pendingStartRequestIdsRef.current.delete(sessionKey);

				if (desiredTaskIdByWorkspaceRef.current.get(session.workspaceId) !== session.taskId) {
					await stopHomeAgentSession(session);
					return;
				}

				if (disposedRef.current) {
					return;
				}

				startedSessionKeysRef.current.add(sessionKey);
				upsertSessionSummary(response.summary);

				// The terminal home-agent panel doesn't render `warningMessage` inline,
				// so surface a start-time warning (e.g. the architect's fleet tools
				// failed to resolve) as a toast — otherwise it goes unseen.
				const startWarning = response.summary.warningMessage?.trim();
				if (startWarning) {
					showAppToast(
						{ intent: "warning", message: startWarning, timeout: Number.POSITIVE_INFINITY },
						`home-agent-warning:${session.workspaceId}:${session.taskId}`,
					);
				}
			} catch (error) {
				if (pendingStartRequestIdsRef.current.get(sessionKey) !== requestId) {
					return;
				}
				pendingStartRequestIdsRef.current.delete(sessionKey);
				if (
					disposedRef.current ||
					desiredTaskIdByWorkspaceRef.current.get(session.workspaceId) !== session.taskId
				) {
					return;
				}
				const message = error instanceof Error ? error.message : String(error);
				notifyError(message);
			}
		})();
	}, [currentProjectId, descriptor, upsertSessionSummary]);

	useEffect(() => {
		return () => {
			disposedRef.current = true;
			desiredTaskIdByWorkspaceRef.current.clear();
			startedSessionKeysRef.current.clear();
			pendingStartRequestIdsRef.current.clear();
			previousTerminalConfigByWorkspaceRef.current.clear();
			previousFreshStartNonceByWorkspaceRef.current.clear();
		};
	}, []);

	return {
		panelMode: descriptor?.panelMode ?? null,
		taskId: descriptor?.taskId ?? null,
	};
}
