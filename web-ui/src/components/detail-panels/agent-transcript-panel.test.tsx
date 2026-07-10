import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentTranscriptPanel } from "@/components/detail-panels/agent-transcript-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ClineChatMessage } from "@/hooks/use-cline-chat-session";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "idle",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: null,
		startedAt: null,
		updatedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		agentSessionId: "session-abc",
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.restoreAllMocks();
});

function renderPanel(panel: ReactElement): void {
	root.render(<TooltipProvider>{panel}</TooltipProvider>);
}

describe("AgentTranscriptPanel", () => {
	it("renders the ended session's prior conversation instead of a blank pane", async () => {
		const messages: ClineChatMessage[] = [
			{ id: "claude-0", role: "user", content: "wire up the resume path", createdAt: 1 },
			{ id: "claude-1", role: "assistant", content: "done, tests are green", createdAt: 2 },
		];

		await act(async () => {
			renderPanel(
				<AgentTranscriptPanel
					taskId="task-1"
					summary={createSummary()}
					onLoadTranscript={async () => ({ present: true, messages })}
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).toContain("wire up the resume path");
		expect(container.textContent).toContain("done, tests are green");
		const messageList = container.querySelector("div.overflow-y-auto");
		expect(messageList).toBeInstanceOf(HTMLDivElement);
		expect(messageList?.children.length).toBe(2);
	});

	it("offers Resume for a resumable session and calls back when clicked", async () => {
		const onResume = vi.fn();
		await act(async () => {
			renderPanel(
				<AgentTranscriptPanel
					taskId="task-1"
					summary={createSummary({ agentSessionLifecycle: "resumable" })}
					onLoadTranscript={async () => ({ present: true, messages: [] })}
					onResume={onResume}
				/>,
			);
			await Promise.resolve();
		});

		const resumeButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Resume session"),
		);
		expect(resumeButton).toBeInstanceOf(HTMLButtonElement);
		await act(async () => {
			resumeButton?.click();
		});
		expect(onResume).toHaveBeenCalledTimes(1);
	});

	it("shows a graceful empty state (never blank) when the transcript is gone on disk", async () => {
		await act(async () => {
			renderPanel(
				<AgentTranscriptPanel
					taskId="task-1"
					summary={createSummary({ agentSessionLifecycle: "gone" })}
					onLoadTranscript={async () => ({ present: false, messages: [] })}
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).toContain("no longer on disk");
		// No Resume affordance for a gone session.
		const resumeButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Resume session"),
		);
		expect(resumeButton).toBeUndefined();
	});
});
