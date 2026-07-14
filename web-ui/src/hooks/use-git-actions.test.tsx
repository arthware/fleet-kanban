import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type UseGitActionsResult, useGitActions } from "@/hooks/use-git-actions";
import type { RuntimeConfigResponse, RuntimeTaskWorkspaceInfoResponse } from "@/runtime/types";
import { clearTaskWorkspaceInfo, clearTaskWorkspaceSnapshot } from "@/stores/workspace-metadata-store";
import type { BoardData } from "@/types";

const showAppToastMock = vi.hoisted(() => vi.fn());
const useGitHistoryDataMock = vi.hoisted(() => vi.fn());
const getDesignDocMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/app-toaster", () => ({
	showAppToast: showAppToastMock,
}));

vi.mock("@/components/git-history/use-git-history-data", () => ({
	useGitHistoryData: useGitHistoryDataMock,
}));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		workspace: {
			getDesignDoc: { query: getDesignDocMock },
		},
	}),
}));

interface HookSnapshot {
	handleAgentCommitTask: UseGitActionsResult["handleAgentCommitTask"];
	runImplementHereAction: UseGitActionsResult["runImplementHereAction"];
}

function createGitHistoryResult(): UseGitActionsResult["gitHistory"] {
	return {
		viewMode: "commit",
		refs: [],
		activeRef: null,
		refsErrorMessage: null,
		isRefsLoading: false,
		workingCopyFileCount: 0,
		hasWorkingCopy: false,
		commits: [],
		totalCommitCount: 0,
		selectedCommitHash: null,
		selectedCommit: null,
		isLogLoading: false,
		isLoadingMoreCommits: false,
		logErrorMessage: null,
		diffSource: null,
		isDiffLoading: false,
		diffErrorMessage: null,
		selectedDiffPath: null,
		selectWorkingCopy: () => {},
		selectRef: () => {},
		selectCommit: () => {},
		selectDiffPath: () => {},
		loadMoreCommits: () => {},
		refresh: () => {},
	};
}

function createBoard(): BoardData {
	return {
		columns: [
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: "task-1",
						title: "Ship it",
						prompt: "Ship it",
						startInPlanMode: false,
						autoReviewEnabled: false,
						autoReviewMode: "commit",
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
		],
		dependencies: [],
	};
}

function createRuntimeConfig(selectedAgentId: RuntimeConfigResponse["selectedAgentId"]): RuntimeConfigResponse {
	return {
		selectedAgentId,
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		effectiveCommand: null,
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
		readyForReviewNotificationsEnabled: true,
		detectedCommands: [],
		agents: [
			{
				id: selectedAgentId,
				label: selectedAgentId,
				binary: selectedAgentId,
				command: selectedAgentId,
				defaultArgs: [],
				installed: true,
				configured: true,
			},
		],
		shortcuts: [],
		worktree: {},
		clineProviderSettings: {
			providerId: "anthropic",
			modelId: "claude-sonnet-4",
			baseUrl: null,
			apiKeyConfigured: true,
			oauthProvider: null,
			oauthAccessTokenConfigured: false,
			oauthRefreshTokenConfigured: false,
			oauthAccountId: null,
			oauthExpiresAt: null,
		},
		commitPromptTemplate: "commit",
		openPrPromptTemplate: "pr",
		commitPromptTemplateDefault: "commit",
		openPrPromptTemplateDefault: "pr",
	};
}

function createWorkspaceInfo(): RuntimeTaskWorkspaceInfoResponse {
	return {
		taskId: "task-1",
		path: "/tmp/task-1",
		exists: true,
		baseRef: "main",
		branch: "task-1",
		isDetached: false,
		headCommit: "abc1234",
	};
}

function HookHarness({
	onSnapshot,
	sendTaskSessionInput,
	sendTaskChatMessage,
	selectedAgentId = "cline",
}: {
	onSnapshot: (snapshot: HookSnapshot) => void;
	sendTaskSessionInput: Parameters<typeof useGitActions>[0]["sendTaskSessionInput"];
	sendTaskChatMessage: Parameters<typeof useGitActions>[0]["sendTaskChatMessage"];
	selectedAgentId?: RuntimeConfigResponse["selectedAgentId"];
}): null {
	const gitActions = useGitActions({
		currentProjectId: "project-1",
		board: createBoard(),
		selectedCard: null,
		runtimeProjectConfig: createRuntimeConfig(selectedAgentId),
		sendTaskSessionInput,
		sendTaskChatMessage,
		fetchTaskWorkspaceInfo: async () => createWorkspaceInfo(),
		isGitHistoryOpen: false,
		refreshWorkspaceState: async () => {},
	});

	useEffect(() => {
		onSnapshot({
			handleAgentCommitTask: gitActions.handleAgentCommitTask,
			runImplementHereAction: gitActions.runImplementHereAction,
		});
	}, [gitActions.handleAgentCommitTask, gitActions.runImplementHereAction, onSnapshot]);

	return null;
}

describe("useGitActions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		showAppToastMock.mockReset();
		useGitHistoryDataMock.mockReset();
		useGitHistoryDataMock.mockReturnValue(createGitHistoryResult());
		getDesignDocMock.mockReset();
		getDesignDocMock.mockResolvedValue({
			exists: true,
			path: "docs/design/task-1-approved-plan.md",
			content: "# Approved plan",
		});
		clearTaskWorkspaceInfo("task-1");
		clearTaskWorkspaceSnapshot("task-1");
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		clearTaskWorkspaceInfo("task-1");
		clearTaskWorkspaceSnapshot("task-1");
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("sends commit prompts through the native cline chat API", async () => {
		const sendTaskSessionInput = vi.fn(async () => ({ ok: true }));
		const sendTaskChatMessage = vi.fn(async () => ({ ok: true }));
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					sendTaskSessionInput={sendTaskSessionInput}
					sendTaskChatMessage={sendTaskChatMessage}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await Promise.resolve();
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		await act(async () => {
			latestSnapshot?.handleAgentCommitTask("task-1");
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(sendTaskChatMessage).toHaveBeenCalledWith("task-1", expect.any(String), { mode: "act" });
		expect(sendTaskSessionInput).not.toHaveBeenCalled();
		expect(showAppToastMock).not.toHaveBeenCalled();
	});

	it("given a native cline review card, when Implement here runs, then it injects the doc-keyed approval-to-build prompt via the chat API in act mode", async () => {
		// given a review card whose design doc resolves, on the native Cline agent
		const sendTaskSessionInput = vi.fn(async () => ({ ok: true }));
		const sendTaskChatMessage = vi.fn(async () => ({ ok: true }));
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					selectedAgentId="cline"
					sendTaskSessionInput={sendTaskSessionInput}
					sendTaskChatMessage={sendTaskChatMessage}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await Promise.resolve();
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		// when Implement here runs for that card
		await act(async () => {
			await latestSnapshot?.runImplementHereAction("task-1");
		});

		// then the approval-to-build prompt (carrying the resolved doc path) is sent
		// through the Cline chat API in act mode, and the PTY path is untouched
		expect(sendTaskChatMessage).toHaveBeenCalledWith(
			"task-1",
			expect.stringContaining("docs/design/task-1-approved-plan.md"),
			{ mode: "act" },
		);
		expect(sendTaskSessionInput).not.toHaveBeenCalled();
		expect(showAppToastMock).not.toHaveBeenCalled();
	});

	it("given a PTY review card, when Implement here runs, then it pastes the doc-keyed approval-to-build prompt and then submits it", async () => {
		// given a review card whose design doc resolves, on a PTY-driven agent
		const sendTaskSessionInput = vi.fn(async () => ({ ok: true }));
		const sendTaskChatMessage = vi.fn(async () => ({ ok: true }));
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					selectedAgentId="claude"
					sendTaskSessionInput={sendTaskSessionInput}
					sendTaskChatMessage={sendTaskChatMessage}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
			await Promise.resolve();
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}

		// when Implement here runs for that card
		await act(async () => {
			await latestSnapshot?.runImplementHereAction("task-1");
		});

		// then the prompt is bracket-pasted and then submitted with a carriage return,
		// and the Cline chat API is untouched
		expect(sendTaskChatMessage).not.toHaveBeenCalled();
		expect(sendTaskSessionInput).toHaveBeenNthCalledWith(
			1,
			"task-1",
			expect.stringContaining("docs/design/task-1-approved-plan.md"),
			{ appendNewline: false, mode: "paste" },
		);
		expect(sendTaskSessionInput).toHaveBeenNthCalledWith(2, "task-1", "\r", { appendNewline: false });
		expect(showAppToastMock).not.toHaveBeenCalled();
	});
});
