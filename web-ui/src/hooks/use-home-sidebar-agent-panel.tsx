// Composes the sidebar agent surface for the current workspace.
// It renders the synthetic home session as a terminal panel and wires that
// surface to shared runtime actions.
import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

import { AgentTerminalPanel } from "@/components/detail-panels/agent-terminal-panel";
import { Spinner } from "@/components/ui/spinner";
import { selectNewestTaskSessionSummary } from "@/hooks/home-sidebar-agent-panel-session-summary";
import { useHomeAgentSession } from "@/hooks/use-home-agent-session";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { RuntimeConfigResponse, RuntimeGitRepositoryInfo, RuntimeTaskSessionSummary } from "@/runtime/types";
import { useTerminalThemeColors } from "@/terminal/theme-colors";

interface UseHomeSidebarAgentPanelInput {
	/**
	 * The workspace that hosts the sidebar agent — the pinned architect when
	 * the board has one, otherwise the selected project. Kept stable across
	 * project-selector changes so the architect session is never torn down or swapped.
	 */
	agentWorkspaceId: string | null;
	hasNoProjects: boolean;
	runtimeProjectConfig: RuntimeConfigResponse | null;
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	workspaceGit: RuntimeGitRepositoryInfo | null;
	startFreshSessionNonce?: number;
}

export function useHomeSidebarAgentPanel({
	agentWorkspaceId,
	hasNoProjects,
	runtimeProjectConfig,
	taskSessions,
	workspaceGit,
	startFreshSessionNonce = 0,
}: UseHomeSidebarAgentPanelInput): ReactElement | null {
	const isMobile = useIsMobile();
	const terminalThemeColors = useTerminalThemeColors();
	const [sessionSummaries, setSessionSummaries] = useState<Record<string, RuntimeTaskSessionSummary>>({});
	const upsertSessionSummary = useCallback((summary: RuntimeTaskSessionSummary) => {
		setSessionSummaries((currentSessions) => {
			const previousSummary = currentSessions[summary.taskId] ?? null;
			const newestSummary = selectNewestTaskSessionSummary(previousSummary, summary);
			if (newestSummary !== summary) {
				return currentSessions;
			}
			return {
				...currentSessions,
				[summary.taskId]: newestSummary,
			};
		});
	}, []);
	const effectiveSessionSummaries = useMemo(() => {
		const mergedSessionSummaries = { ...taskSessions };
		for (const [taskId, summary] of Object.entries(sessionSummaries)) {
			const newestSummary = selectNewestTaskSessionSummary(mergedSessionSummaries[taskId] ?? null, summary);
			if (newestSummary) {
				mergedSessionSummaries[taskId] = newestSummary;
			}
		}
		return mergedSessionSummaries;
	}, [sessionSummaries, taskSessions]);
	const { panelMode, taskId } = useHomeAgentSession({
		currentProjectId: agentWorkspaceId,
		runtimeProjectConfig,
		workspaceGit,
		upsertSessionSummary,
		startFreshSessionNonce,
	});

	const selectedAgentLabel = useMemo(() => {
		if (!runtimeProjectConfig) {
			return "selected agent";
		}
		return (
			runtimeProjectConfig.agents.find((agent) => agent.id === runtimeProjectConfig.selectedAgentId)?.label ??
			"selected agent"
		);
	}, [runtimeProjectConfig]);

	const homeAgentPanelSummary = taskId ? (effectiveSessionSummaries[taskId] ?? null) : null;

	if (hasNoProjects || !agentWorkspaceId) {
		return null;
	}

	if (!runtimeProjectConfig) {
		return (
			<div className="flex w-full items-center justify-center rounded-md border border-border bg-surface-2 px-3 py-6">
				<Spinner size={20} />
			</div>
		);
	}

	if (panelMode === "terminal" && taskId) {
		return (
			<AgentTerminalPanel
				key={taskId}
				taskId={taskId}
				workspaceId={agentWorkspaceId}
				summary={homeAgentPanelSummary}
				onSummary={upsertSessionSummary}
				showSessionToolbar={false}
				autoFocus={!isMobile}
				panelBackgroundColor="var(--color-surface-1)"
				terminalBackgroundColor={terminalThemeColors.surfaceRaised}
				cursorColor={terminalThemeColors.textPrimary}
			/>
		);
	}

	return (
		<div className="flex w-full items-center justify-center rounded-md border border-border bg-surface-2 px-3 text-center text-sm text-text-secondary">
			No runnable {selectedAgentLabel} command is configured. Open Settings, install the CLI, and select it.
		</div>
	);
}
