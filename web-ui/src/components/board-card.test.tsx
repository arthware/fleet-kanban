import type { ReactNode } from "react";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardCard } from "@/components/board-card";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { ReviewTaskWorkspaceSnapshot } from "@/types";

let mockWorkspaceSnapshot: ReviewTaskWorkspaceSnapshot | undefined;
let mockMeasureWidths = [240, 240, 240];
let mockMeasureCallCount = 0;

vi.mock("@hello-pangea/dnd", () => ({
	Draggable: ({
		children,
	}: {
		children: (
			provided: {
				innerRef: (element: HTMLDivElement | null) => void;
				draggableProps: object;
				dragHandleProps: object;
			},
			snapshot: { isDragging: boolean },
		) => ReactNode;
	}): React.ReactElement => (
		<>{children({ innerRef: () => {}, draggableProps: {}, dragHandleProps: {} }, { isDragging: false })}</>
	),
}));

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceSnapshotValue: () => mockWorkspaceSnapshot,
}));

vi.mock("@/utils/react-use", () => ({
	useMedia: () => false,
	useMeasure: () => {
		mockMeasureCallCount += 1;
		const width = mockMeasureWidths[(mockMeasureCallCount - 1) % mockMeasureWidths.length] ?? 240;
		return [
			() => {},
			{
				width,
				height: 0,
				top: 0,
				left: 0,
				bottom: 0,
				right: 0,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			},
		];
	},
}));

vi.mock("@/utils/text-measure", () => ({
	DEFAULT_TEXT_MEASURE_FONT: "400 14px sans-serif",
	measureTextWidth: (value: string) => value.length * 8,
	readElementFontShorthand: () => "400 14px sans-serif",
}));

vi.mock("@/utils/task-prompt", async () => {
	const actual = await vi.importActual<typeof import("@/utils/task-prompt")>("@/utils/task-prompt");
	return {
		...actual,
		truncateTaskPromptLabel: (prompt: string) => prompt.split("||")[0]?.trim() ?? "",
		normalizePromptForDisplay: (value: string) => value.split("||")[0]?.trim() ?? value.trim(),
		getTaskPromptDescription: (prompt: string, title: string) => {
			const normalized = prompt.trim();
			if (!normalized.startsWith(title)) {
				return normalized;
			}
			return normalized.slice(title.length).replace(/^\|\|/, "").trim();
		},
	};
});

function createCard(overrides?: Partial<Parameters<typeof BoardCard>[0]["card"]>) {
	return {
		id: "task-1",
		title: "Review API changes",
		prompt: "Review API changes",
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit" as const,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function createSummary(
	state: RuntimeTaskSessionSummary["state"],
	overrides?: Partial<RuntimeTaskSessionSummary>,
): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state,
		agentId: "cline",
		workspacePath: "/tmp/worktree",
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		agentSessionId: null,
		lastHookAt: 1,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function Harness(): React.ReactElement {
	const [card, setCard] = useState(
		createCard({
			autoReviewEnabled: true,
			autoReviewMode: "pr",
		}),
	);

	return (
		<BoardCard
			card={card}
			index={0}
			columnId="backlog"
			onCancelAutomaticAction={() => {
				setCard((currentCard) => ({
					...currentCard,
					autoReviewEnabled: false,
				}));
			}}
		/>
	);
}

describe("BoardCard", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		mockWorkspaceSnapshot = undefined;
		mockMeasureWidths = [240, 240, 240];
		mockMeasureCallCount = 0;
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			width: 240,
			height: 32,
			right: 240,
			bottom: 32,
			toJSON: () => ({}),
		}));
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("shows a mode-specific cancel button and hides it after canceling auto review", async () => {
		await act(async () => {
			root.render(<Harness />);
		});

		const cancelButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Cancel Auto-PR",
		);
		expect(cancelButton).toBeDefined();

		await act(async () => {
			cancelButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			cancelButton?.click();
		});

		const nextCancelButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Cancel Auto-"),
		);
		expect(nextCancelButton).toBeUndefined();
	});

	it("shows a loading state on the review done button while moving to done", async () => {
		await act(async () => {
			root.render(<BoardCard card={createCard()} index={0} columnId="review" isMoveToTrashLoading />);
		});

		const trashButton = container.querySelector('button[aria-label="Move task to done"]');
		expect(trashButton).toBeInstanceOf(HTMLButtonElement);
		expect((trashButton as HTMLButtonElement | null)?.disabled).toBe(true);
		expect(trashButton?.querySelector("svg.animate-spin")).toBeTruthy();
	});

	it("shows inline see more and less controls for long descriptions", async () => {
		const description =
			"Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau final hidden segment";

		await act(async () => {
			root.render(
				<BoardCard card={createCard({ prompt: `Task title||${description}` })} index={0} columnId="backlog" />,
			);
		});

		const findButton = (label: string) =>
			Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);

		const seeMoreButton = findButton("See more");
		expect(seeMoreButton).toBeDefined();
		expect(container.textContent).not.toContain("final hidden segment");

		await act(async () => {
			seeMoreButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			seeMoreButton?.click();
		});

		expect(findButton("See more")).toBeUndefined();
		expect(findButton("Less")).toBeDefined();
		expect(container.textContent).toContain(description);

		const lessButton = findButton("Less");
		await act(async () => {
			lessButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			lessButton?.click();
		});

		expect(findButton("See more")).toBeDefined();
		expect(container.textContent).not.toContain("final hidden segment");
	});

	it("reconstructs and shows trashed worktree path when workspace metadata is not tracked", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard({ id: "trash-task-1" })}
						index={0}
						columnId="trash"
						workspacePath="/Users/alice/projects/kanban"
					/>
				</TooltipProvider>,
			);
		});

		expect(container.textContent).toContain("~/.cline/worktrees/trash-task-1/kanban");
	});

	it("shows Resume for resumable trashed sessions", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="trash"
						sessionSummary={createSummary("idle", {
							agentSessionId: "session-to-resume",
							agentSessionLifecycle: "resumable",
						})}
					/>
				</TooltipProvider>,
			);
		});

		const resumeButton = container.querySelector('button[aria-label="Resume task from done"]');
		expect(resumeButton).toBeInstanceOf(HTMLButtonElement);
		expect(resumeButton?.textContent?.trim()).toBe("Resume");
	});

	it("shows Start fresh for gone trashed sessions", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="trash"
						sessionSummary={createSummary("idle", {
							agentSessionId: "dead-session",
							agentSessionLifecycle: "gone",
						})}
					/>
				</TooltipProvider>,
			);
		});

		const startFreshButton = container.querySelector('button[aria-label="Start fresh task from done"]');
		expect(startFreshButton).toBeInstanceOf(HTMLButtonElement);
		expect(startFreshButton?.textContent?.trim()).toBe("Start fresh");
	});

	it("shows the card's short id near the title", async () => {
		await act(async () => {
			root.render(<BoardCard card={createCard({ id: "cc618" })} index={0} columnId="backlog" />);
		});

		expect(container.textContent).toContain("cc618");
	});

	it("shows the per-card agent model override as a friendly name", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({ agentId: "claude", agentModel: "claude-haiku-4-5" })}
					index={0}
					columnId="backlog"
				/>,
			);
		});

		expect(container.textContent).toContain("Claude Code");
		expect(container.textContent).toContain("Haiku 4.5");
		expect(container.textContent).not.toContain("claude-haiku-4-5");
	});

	it("shows the raw model id when a card's agentModel override is unknown to the display-name table", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({ agentId: "codex", agentModel: "gpt-5.1-codex-mini" })}
					index={0}
					columnId="backlog"
				/>,
			);
		});

		expect(container.textContent).toContain("gpt-5.1-codex-mini");
	});

	it("shows the agent with a muted default model label when no override is set", async () => {
		await act(async () => {
			root.render(<BoardCard card={createCard({ agentId: "claude" })} index={0} columnId="backlog" />);
		});

		expect(container.textContent).toContain("Claude Code");
		expect(container.textContent).toContain("default");
		expect(container.textContent).not.toContain("claude-haiku-4-5");
	});

	it("falls back to the workspace default agent when a card never set one", async () => {
		await act(async () => {
			root.render(<BoardCard card={createCard()} index={0} columnId="backlog" defaultAgentId="codex" />);
		});

		expect(container.textContent).toContain("OpenAI Codex");
	});

	it("shows nothing agent-related for a card with neither its own agent nor a known workspace default", async () => {
		await act(async () => {
			root.render(<BoardCard card={createCard()} index={0} columnId="backlog" />);
		});

		expect(container.textContent).not.toContain("claude-haiku-4-5");
		expect(container.textContent).not.toContain("default");
	});

	it("shows formatted agent override details with model name and reasoning effort", async () => {
		mockWorkspaceSnapshot = {
			taskId: "task-1",
			path: "/tmp/worktrees/task-1",
			branch: "feature/override",
			isDetached: false,
			headCommit: "1234567890abcdef",
			changedFiles: 2,
			additions: 5,
			deletions: 1,
		};

		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({
						agentId: "cline",
						clineSettings: {
							modelId: "openai/gpt-5.5",
							reasoningEffort: "low",
						},
					})}
					index={0}
					columnId="review"
				/>,
			);
		});

		expect(container.textContent).toContain("Cline");
		expect(container.textContent).toContain("GPT-5.5 (Low)");
		expect(container.textContent).not.toContain("openai/gpt-5.5");
	});

	it("shows the task-level indicator for reasoning-only overrides", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({
						clineSettings: {
							reasoningEffort: "low",
						},
					})}
					index={0}
					columnId="backlog"
					defaultClineModelId="openai/gpt-5.5"
				/>,
			);
		});

		expect(container.textContent).toContain("GPT-5.5 (Low)");
	});

	it("shows a fallback indicator for reasoning-only overrides without a resolved default model", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({
						clineSettings: {
							reasoningEffort: "low",
						},
					})}
					index={0}
					columnId="backlog"
				/>,
			);
		});

		expect(container.textContent).toContain("Default model (Low)");
	});

	it("shows explicit default reasoning metadata for reasoning-only task overrides", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({
						agentId: "cline",
						clineSettings: {},
					})}
					index={0}
					columnId="backlog"
					defaultClineModelId="openai/gpt-5.5"
				/>,
			);
		});

		expect(container.textContent).toContain("GPT-5.5 (Default)");
		expect(container.textContent).not.toContain("GPT-5.5 (High)");
	});

	it("does not mislabel provider-only overrides as the global default model", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({
						clineSettings: {
							providerId: "groq",
						},
					})}
					index={0}
					columnId="backlog"
					defaultClineModelId="openai/gpt-5.5"
				/>,
			);
		});

		expect(container.textContent).toContain("Provider: groq");
		expect(container.textContent).not.toContain("GPT-5.5");
	});

	it("does not show inherited global reasoning for explicit model overrides using default effort", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({
						agentId: "cline",
						clineSettings: {
							modelId: "openai/gpt-5.5",
						},
					})}
					index={0}
					columnId="backlog"
				/>,
			);
		});

		expect(container.textContent).toContain("GPT-5.5");
		expect(container.textContent).not.toContain("GPT-5.5 (High)");
	});

	it("shows tool input details in the session preview text", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={{
						taskId: "task-1",
						state: "running",
						agentId: "cline",
						workspacePath: "/tmp/worktree",
						pid: null,
						startedAt: Date.now(),
						updatedAt: Date.now(),
						lastOutputAt: Date.now(),
						reviewReason: null,
						exitCode: null,
						agentSessionId: null,
						lastHookAt: Date.now(),
						latestHookActivity: {
							activityText: "Using Read",
							toolName: "Read",
							toolInputSummary: "src/index.ts",
							finalMessage: null,
							hookEventName: "tool_call",
							notificationType: null,
							source: "cline-sdk",
						},
						latestTurnCheckpoint: null,
						previousTurnCheckpoint: null,
					}}
				/>,
			);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Using Read");
	});

	it("shows non-cline tool activity in the compact tool label format", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						agentId: "claude",
						latestHookActivity: {
							activityText: "Completed Read: src/index.ts",
							toolName: "Read",
							toolInputSummary: null,
							finalMessage: null,
							hookEventName: "tool_result",
							notificationType: null,
							source: "claude",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Completed Read");
	});

	it("keeps canonical tool names in the session preview label", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						agentId: "kiro",
						latestHookActivity: {
							activityText: "Using fs_write: src/index.ts",
							toolName: "fs_write",
							toolInputSummary: null,
							finalMessage: null,
							hookEventName: "preToolUse",
							notificationType: null,
							source: "kiro",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("fs_write(src/index.ts)");
	});

	it("parses codex tool activity into the compact tool label format", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						agentId: "codex",
						latestHookActivity: {
							activityText: "Calling Read: src/index.ts",
							toolName: null,
							toolInputSummary: null,
							finalMessage: null,
							hookEventName: "raw_response_item",
							notificationType: null,
							source: "codex",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Calling Read");
	});

	it("does not show a stale bare tool name for non-tool review updates", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="review"
					sessionSummary={createSummary("awaiting_review", {
						agentId: "kiro",
						latestHookActivity: {
							activityText: "Waiting for review",
							toolName: "fs_write",
							toolInputSummary: null,
							finalMessage: null,
							hookEventName: "stop",
							notificationType: null,
							source: "kiro",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("Waiting for review");
		expect(container.textContent).not.toContain("fs_write");
	});

	it("keeps showing the last cline tool label during assistant streaming", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={{
						taskId: "task-1",
						state: "running",
						agentId: "cline",
						workspacePath: "/tmp/worktree",
						pid: null,
						startedAt: Date.now(),
						updatedAt: Date.now(),
						lastOutputAt: Date.now(),
						reviewReason: null,
						exitCode: null,
						agentSessionId: null,
						lastHookAt: Date.now(),
						latestHookActivity: {
							activityText: "Agent active",
							toolName: "Read",
							toolInputSummary: "src/index.ts",
							finalMessage: "Looking at the file now",
							hookEventName: "assistant_delta",
							notificationType: null,
							source: "cline-sdk",
						},
						latestTurnCheckpoint: null,
						previousTurnCheckpoint: null,
					}}
				/>,
			);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Thinking...");
	});

	it("renders a new card description before the async measure observer reports width", async () => {
		mockMeasureWidths = [0, 0, 0];

		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({ prompt: "Task title||Freshly created task description" })}
					index={0}
					columnId="backlog"
				/>,
			);
		});

		expect(container.textContent).toContain("Freshly created task description");
	});

	it("renders session activity as single-line truncated text on trash cards", async () => {
		const preview =
			"Reviewing the archived implementation details and collecting the final notes for the handoff before cleanup hidden tail";

		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="trash"
						sessionSummary={createSummary("awaiting_review", {
							latestHookActivity: {
								activityText: null,
								toolName: null,
								toolInputSummary: null,
								finalMessage: preview,
								hookEventName: "assistant_delta",
								notificationType: null,
								source: "cline-sdk",
							},
						})}
					/>
				</TooltipProvider>,
			);
		});

		const findButton = (label: string) =>
			Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);

		// Session activity uses CSS truncation with no See more / Less buttons
		expect(findButton("See more")).toBeUndefined();
		expect(findButton("Less")).toBeUndefined();

		// The full text is in the DOM (CSS handles visual truncation)
		expect(container.textContent).toContain(preview);
	});

	it("renders session activity as single-line truncated text for running tasks", async () => {
		const preview =
			"Reviewing the archived implementation details and collecting the final notes for the handoff before cleanup hidden tail";

		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						latestHookActivity: {
							activityText: null,
							toolName: null,
							toolInputSummary: null,
							finalMessage: preview,
							hookEventName: "assistant_delta",
							notificationType: null,
							source: "cline-sdk",
						},
					})}
				/>,
			);
		});

		const findButton = (label: string) =>
			Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);

		// Session activity uses CSS truncation with no See more / Less buttons
		expect(findButton("See more")).toBeUndefined();
		expect(findButton("Less")).toBeUndefined();

		// The full text is in the DOM (CSS handles visual truncation)
		expect(container.textContent).toContain(preview);
	});

	it("shows the latest assistant preview on active task cards", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						latestHookActivity: {
							activityText: "Reviewing the final diff",
							toolName: null,
							toolInputSummary: null,
							finalMessage: "Reviewing the final diff",
							hookEventName: "assistant_delta",
							notificationType: null,
							source: "cline-sdk",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("Reviewing the final diff");
		expect(container.textContent).not.toContain("Thinking...");
	});

	it("shows a humanized token-usage chip when a card has usage", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({ agentId: "claude", agentModel: "claude-opus-4-8" })}
					index={0}
					columnId="in_progress"
					tokenUsage={{
						inputTokens: 1_100_000,
						outputTokens: 100_000,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
						costUsd: null,
					}}
				/>,
			);
		});

		expect(container.textContent).toContain("1.2M tok");
	});

	it("renders the token-usage chip next to the agent model label", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({ agentId: "claude", agentModel: "claude-haiku-4-5" })}
					index={0}
					columnId="in_progress"
					tokenUsage={{
						inputTokens: 2_345,
						outputTokens: 0,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
						costUsd: null,
					}}
				/>,
			);
		});

		const usageChip = Array.from(container.querySelectorAll("span")).find(
			(element) => element.textContent?.trim() === "2.3K tok",
		);
		expect(usageChip).toBeDefined();
		// The chip shares the model chip's row (adjacent), but is a separate
		// element carrying its own muted styling — the model label is NOT inside it.
		expect(usageChip?.parentElement?.textContent).toContain("Haiku 4.5");
		expect(usageChip?.textContent).not.toContain("Haiku 4.5");
	});

	it("appends an estimated cost to the token chip when cost is known", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({ agentId: "claude", agentModel: "claude-opus-4-8" })}
					index={0}
					columnId="in_progress"
					tokenUsage={{
						inputTokens: 1_100_000,
						outputTokens: 100_000,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
						costUsd: 3.4,
					}}
				/>,
			);
		});

		const usageChip = Array.from(container.querySelectorAll("span")).find((element) =>
			element.textContent?.includes("1.2M tok"),
		);
		expect(usageChip?.textContent).toBe("1.2M tok · $3.40");
	});

	it("shows a sub-cent estimate as a less-than marker on the chip", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({ agentId: "claude", agentModel: "claude-haiku-4-5" })}
					index={0}
					columnId="in_progress"
					tokenUsage={{
						inputTokens: 2_345,
						outputTokens: 0,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
						costUsd: 0.004,
					}}
				/>,
			);
		});

		const usageChip = Array.from(container.querySelectorAll("span")).find((element) =>
			element.textContent?.includes("2.3K tok"),
		);
		expect(usageChip?.textContent).toBe("2.3K tok · <$0.01");
	});

	it("shows only tokens, no cost segment, when cost is unknown", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({ agentId: "codex" })}
					index={0}
					columnId="in_progress"
					tokenUsage={{
						inputTokens: 1_100_000,
						outputTokens: 100_000,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
						costUsd: null,
					}}
				/>,
			);
		});

		const usageChip = Array.from(container.querySelectorAll("span")).find((element) =>
			element.textContent?.includes("1.2M tok"),
		);
		expect(usageChip?.textContent).toBe("1.2M tok");
		expect(usageChip?.textContent).not.toContain("$");
	});

	it("does not render a token-usage chip when usage is absent", async () => {
		await act(async () => {
			root.render(
				<BoardCard card={createCard({ agentId: "claude" })} index={0} columnId="in_progress" tokenUsage={null} />,
			);
		});

		expect(container.textContent).not.toContain("tok");
	});

	it("does not render a token-usage chip for an all-zero total", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({ agentId: "claude" })}
					index={0}
					columnId="in_progress"
					tokenUsage={{
						inputTokens: 0,
						outputTokens: 0,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
						costUsd: null,
					}}
				/>,
			);
		});

		expect(container.textContent).not.toContain("tok");
	});

	it("headlines the real conversational work, not the cache-read-inflated total", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({ agentId: "claude", agentModel: "claude-opus-4-8" })}
					index={0}
					columnId="in_progress"
					tokenUsage={{
						inputTokens: 74_000,
						outputTokens: 608_000,
						cacheReadTokens: 84_000_000,
						cacheCreationTokens: 3_200_000,
						costUsd: null,
					}}
				/>,
			);
		});

		// input+output = 682K of real work; the 88M raw total (dominated by
		// re-read cache) must not become the headline.
		const usageChip = Array.from(container.querySelectorAll("span")).find((element) =>
			element.textContent?.includes("682K tok"),
		);
		expect(usageChip?.textContent).toBe("682K tok");
		expect(container.textContent).not.toContain("87.9M tok");
	});

	it("exposes the grand token total in the chip tooltip so the headline gap is self-explaining", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({ agentId: "claude", agentModel: "claude-opus-4-8" })}
					index={0}
					columnId="in_progress"
					tokenUsage={{
						inputTokens: 74_000,
						outputTokens: 608_000,
						cacheReadTokens: 84_000_000,
						cacheCreationTokens: 3_200_000,
						costUsd: null,
					}}
				/>,
			);
		});

		const usageChip = Array.from(container.querySelectorAll("span")).find((element) =>
			element.textContent?.includes("682K tok"),
		);
		const tooltip = usageChip?.getAttribute("title") ?? "";
		expect(tooltip).toContain(`${(74_000).toLocaleString()} in`);
		expect(tooltip).toContain(`${(608_000).toLocaleString()} out`);
		expect(tooltip).toContain(`${(84_000_000).toLocaleString()} cache read`);
		expect(tooltip).toContain(`${(3_200_000).toLocaleString()} cache write`);
		expect(tooltip).toContain(`${(87_882_000).toLocaleString()} total`);
	});

	it("appends the cost estimate to a cache-heavy card's real-work headline", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({ agentId: "claude", agentModel: "claude-opus-4-8" })}
					index={0}
					columnId="in_progress"
					tokenUsage={{
						inputTokens: 74_000,
						outputTokens: 608_000,
						cacheReadTokens: 84_000_000,
						cacheCreationTokens: 3_200_000,
						costUsd: 77.2,
					}}
				/>,
			);
		});

		const usageChip = Array.from(container.querySelectorAll("span")).find((element) =>
			element.textContent?.includes("682K tok"),
		);
		expect(usageChip?.textContent).toBe("682K tok · $77.20");
	});

	it("renders no chip for a card with only cached context and no real work or cost", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({ agentId: "claude" })}
					index={0}
					columnId="in_progress"
					tokenUsage={{
						inputTokens: 0,
						outputTokens: 0,
						cacheReadTokens: 5_000_000,
						cacheCreationTokens: 120_000,
						costUsd: null,
					}}
				/>,
			);
		});

		expect(container.textContent).not.toContain("tok");
	});

	it("shows normal agent messages without the agent prefix", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						agentId: "codex",
						latestHookActivity: {
							activityText: "Agent: checking the next file",
							toolName: null,
							toolInputSummary: null,
							finalMessage: null,
							hookEventName: "agent_message",
							notificationType: null,
							source: "codex",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("checking the next file");
		expect(container.textContent).not.toContain("Agent:");
	});
});
