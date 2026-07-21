import { useCallback, useMemo, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { type UseGitHistoryDataResult, useGitHistoryData } from "@/components/git-history/use-git-history-data";
import { buildImplementHerePrompt } from "@/git-actions/build-implement-here-prompt";
import { isNativeClineAgentSelected } from "@/runtime/native-agent";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeConfigResponse, RuntimeGitSyncAction, RuntimeTaskWorkspaceInfoResponse } from "@/runtime/types";
import { findCardSelection } from "@/state/board-state";
import {
	setHomeGitSummary,
	useHomeGitStateVersionValue,
	useHomeGitSummaryValue,
	useTaskWorkspaceSnapshotValue,
	useTaskWorkspaceStateVersionValue,
} from "@/stores/workspace-metadata-store";
import type { SendTerminalInputOptions } from "@/terminal/terminal-input";
import type { BoardCard, BoardData, CardSelection } from "@/types";

interface UseGitActionsInput {
	currentProjectId: string | null;
	board: BoardData;
	selectedCard: CardSelection | null;
	runtimeProjectConfig: RuntimeConfigResponse | null;
	sendTaskSessionInput: (
		taskId: string,
		text: string,
		options?: SendTerminalInputOptions,
	) => Promise<{ ok: boolean; message?: string }>;
	sendTaskChatMessage: (
		taskId: string,
		text: string,
		options?: { mode?: "plan" | "act" },
	) => Promise<{ ok: boolean; message?: string }>;
	fetchTaskWorkspaceInfo: (task: BoardCard) => Promise<RuntimeTaskWorkspaceInfoResponse | null>;
	isGitHistoryOpen: boolean;
	refreshWorkspaceState: () => Promise<void>;
}

export interface UseGitActionsResult {
	runningGitAction: RuntimeGitSyncAction | null;
	isSwitchingHomeBranch: boolean;
	isDiscardingHomeWorkingChanges: boolean;
	gitActionError: {
		action: RuntimeGitSyncAction;
		message: string;
		output: string;
	} | null;
	gitActionErrorTitle: string;
	clearGitActionError: () => void;
	gitHistory: UseGitHistoryDataResult;
	runGitAction: (action: RuntimeGitSyncAction) => Promise<void>;
	switchHomeBranch: (branch: string) => Promise<void>;
	discardHomeWorkingChanges: () => Promise<void>;
	runImplementHereAction: (taskId: string) => Promise<boolean>;
	resetGitActionState: () => void;
}

export function useGitActions({
	currentProjectId,
	board,
	selectedCard,
	runtimeProjectConfig,
	sendTaskSessionInput,
	sendTaskChatMessage,
	isGitHistoryOpen,
	refreshWorkspaceState,
}: UseGitActionsInput): UseGitActionsResult {
	const [runningGitAction, setRunningGitAction] = useState<RuntimeGitSyncAction | null>(null);
	const [isSwitchingHomeBranch, setIsSwitchingHomeBranch] = useState(false);
	const [isDiscardingHomeWorkingChanges, setIsDiscardingHomeWorkingChanges] = useState(false);
	const [gitActionError, setGitActionError] = useState<{
		action: RuntimeGitSyncAction;
		message: string;
		output: string;
	} | null>(null);
	const homeGitSummary = useHomeGitSummaryValue();
	const homeGitStateVersion = useHomeGitStateVersionValue();
	const selectedTaskWorkspaceSnapshot = useTaskWorkspaceSnapshotValue(selectedCard?.card.id ?? null);
	const selectedTaskWorkspaceStateVersion = useTaskWorkspaceStateVersionValue(selectedCard?.card.id ?? null);

	const gitHistoryTaskScope = useMemo(() => {
		if (!selectedCard) {
			return null;
		}
		return {
			taskId: selectedCard.card.id,
			baseRef: selectedCard.card.baseRef,
		};
	}, [selectedCard?.card.baseRef, selectedCard?.card.id]);

	const gitHistorySummary = useMemo(() => {
		if (!selectedCard) {
			return homeGitSummary;
		}
		if (!selectedTaskWorkspaceSnapshot) {
			return null;
		}
		return {
			currentBranch: selectedTaskWorkspaceSnapshot.branch,
			upstreamBranch: null,
			changedFiles: selectedTaskWorkspaceSnapshot.changedFiles ?? 0,
			additions: selectedTaskWorkspaceSnapshot.additions ?? 0,
			deletions: selectedTaskWorkspaceSnapshot.deletions ?? 0,
			aheadCount: 0,
			behindCount: 0,
		};
	}, [homeGitSummary, selectedCard, selectedTaskWorkspaceSnapshot]);
	const gitHistoryStateVersion = selectedCard ? selectedTaskWorkspaceStateVersion : homeGitStateVersion;

	const gitHistory = useGitHistoryData({
		workspaceId: currentProjectId,
		taskScope: gitHistoryTaskScope,
		gitSummary: gitHistorySummary,
		stateVersion: gitHistoryStateVersion,
		enabled: isGitHistoryOpen,
	});
	const refreshGitHistory = gitHistory.refresh;

	const shouldUseClineChatForTaskGitActions = isNativeClineAgentSelected(
		runtimeProjectConfig?.selectedAgentId ?? null,
	);

	// Approve-to-build for a plan card. Resolving the doc path server-side via
	// `getDesignDoc` reuses the badge's resolver instead of re-deriving the path.
	// The live-session guard lives one layer up where session summaries are in scope.
	const runImplementHereAction = useCallback(
		async (taskId: string): Promise<boolean> => {
			if (!currentProjectId) {
				return false;
			}
			const selection = findCardSelection(board, taskId);
			if (!selection || selection.column.id !== "review") {
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message: "Implement here is only available for tasks in Review.",
					timeout: 5000,
				});
				return false;
			}
			const externalIssueKey = selection.card.externalIssue?.key;
			const designDoc = await getRuntimeTrpcClient(currentProjectId)
				.workspace.getDesignDoc.query({
					taskId,
					...(externalIssueKey ? { externalIssueKey } : {}),
				})
				.catch(() => null);
			if (!designDoc?.exists || !designDoc.path) {
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message: "No approved design doc found for this card.",
					timeout: 6000,
				});
				return false;
			}
			const prompt = buildImplementHerePrompt(designDoc.path);
			if (shouldUseClineChatForTaskGitActions) {
				const sent = await sendTaskChatMessage(taskId, prompt, { mode: "act" });
				if (!sent.ok) {
					showAppToast({
						intent: "danger",
						icon: "warning-sign",
						message: sent.message ?? "Could not send the implement-here instructions to the task chat session.",
						timeout: 7000,
					});
					return false;
				}
				return true;
			}
			const typed = await sendTaskSessionInput(taskId, prompt, { appendNewline: false, mode: "paste" });
			if (!typed.ok) {
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: typed.message ?? "Could not send the implement-here instructions to the task session.",
					timeout: 7000,
				});
				return false;
			}
			await new Promise<void>((resolve) => {
				window.setTimeout(resolve, 200);
			});
			const submitted = await sendTaskSessionInput(taskId, "\r", { appendNewline: false });
			if (!submitted.ok) {
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: submitted.message ?? "Could not submit the implement-here instructions to the task session.",
					timeout: 7000,
				});
				return false;
			}
			return true;
		},
		[board, currentProjectId, sendTaskChatMessage, sendTaskSessionInput, shouldUseClineChatForTaskGitActions],
	);

	const runGitAction = useCallback(
		async (action: RuntimeGitSyncAction) => {
			if (!currentProjectId || runningGitAction || isSwitchingHomeBranch) {
				return;
			}
			setRunningGitAction(action);
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.workspace.runGitSyncAction.mutate({ action });
				if (!payload.ok || !payload.summary) {
					const errorMessage = payload.error ?? `${action} failed.`;
					const output = payload.output ?? "";
					const fallbackSummary = payload.summary ?? null;
					if (fallbackSummary) {
						setHomeGitSummary(fallbackSummary);
					}
					setGitActionError({
						action,
						message: errorMessage,
						output,
					});
					return;
				}
				setHomeGitSummary(payload.summary);
				refreshGitHistory();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				setGitActionError({
					action,
					message,
					output: "",
				});
			} finally {
				setRunningGitAction(null);
			}
		},
		[currentProjectId, isSwitchingHomeBranch, refreshGitHistory, runningGitAction],
	);

	const switchHomeBranch = useCallback(
		async (branch: string) => {
			const normalizedBranch = branch.trim();
			const currentBranch = homeGitSummary?.currentBranch ?? null;
			if (!currentProjectId || isSwitchingHomeBranch || !normalizedBranch || normalizedBranch === currentBranch) {
				return;
			}
			setIsSwitchingHomeBranch(true);
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.workspace.checkoutGitBranch.mutate({
					branch: normalizedBranch,
				});
				if (!payload.ok || !payload.summary) {
					const errorMessage = payload.error ?? "Switch branch failed.";
					const fallbackSummary = payload.summary ?? null;
					if (fallbackSummary) {
						setHomeGitSummary(fallbackSummary);
					}
					showAppToast({
						intent: "danger",
						icon: "warning-sign",
						message: `Could not switch to ${normalizedBranch}. ${errorMessage}`,
						timeout: 7000,
					});
					return;
				}
				setHomeGitSummary(payload.summary);
				refreshGitHistory();
				await refreshWorkspaceState();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: `Could not switch to ${normalizedBranch}. ${message}`,
					timeout: 7000,
				});
			} finally {
				setIsSwitchingHomeBranch(false);
			}
		},
		[
			currentProjectId,
			homeGitSummary?.currentBranch,
			isSwitchingHomeBranch,
			refreshGitHistory,
			refreshWorkspaceState,
		],
	);

	const discardHomeWorkingChanges = useCallback(async () => {
		if (!currentProjectId || isDiscardingHomeWorkingChanges) {
			return;
		}
		setIsDiscardingHomeWorkingChanges(true);
		try {
			const trpcClient = getRuntimeTrpcClient(currentProjectId);
			const payload = await trpcClient.workspace.discardGitChanges.mutate(null);
			if (!payload.ok) {
				if (payload.summary) {
					setHomeGitSummary(payload.summary);
				}
				showAppToast({
					intent: "danger",
					icon: "warning-sign",
					message: payload.error ?? "Could not discard working copy changes.",
					timeout: 7000,
				});
				return;
			}
			setHomeGitSummary(payload.summary);
			refreshGitHistory();
			showAppToast({
				intent: "success",
				icon: "tick",
				message: "Discarded working copy changes.",
				timeout: 4000,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			showAppToast({
				intent: "danger",
				icon: "warning-sign",
				message: `Could not discard working copy changes. ${message}`,
				timeout: 7000,
			});
		} finally {
			setIsDiscardingHomeWorkingChanges(false);
		}
	}, [currentProjectId, isDiscardingHomeWorkingChanges, refreshGitHistory]);

	const resetGitActionState = useCallback(() => {
		setRunningGitAction(null);
		setIsSwitchingHomeBranch(false);
		setIsDiscardingHomeWorkingChanges(false);
		setGitActionError(null);
	}, []);

	const gitActionErrorTitle = useMemo(() => {
		if (!gitActionError) {
			return "Git action failed";
		}
		if (gitActionError.action === "fetch") {
			return "Fetch failed";
		}
		if (gitActionError.action === "pull") {
			return "Pull failed";
		}
		return "Push failed";
	}, [gitActionError]);

	return {
		runningGitAction,
		isSwitchingHomeBranch,
		isDiscardingHomeWorkingChanges,
		gitActionError,
		gitActionErrorTitle,
		clearGitActionError: () => {
			setGitActionError(null);
		},
		gitHistory,
		runGitAction,
		switchHomeBranch,
		discardHomeWorkingChanges,
		runImplementHereAction,
		resetGitActionState,
	};
}
