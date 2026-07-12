import { Draggable } from "@hello-pangea/dnd";
import { getRuntimeAgentCatalogEntry } from "@runtime-agent-catalog";
import { formatClineToolCallLabel } from "@runtime-cline-tool-call-display";
import { buildTaskWorktreeDisplayPath } from "@runtime-task-worktree-path";
import {
	AlertCircle,
	AlertTriangle,
	Bot,
	CheckCircle2,
	GitBranch,
	MessageCircleQuestion,
	Pencil,
	Play,
	RotateCcw,
	Trash2,
} from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	formatClineReasoningEffortLabel,
	formatClineSelectedModelButtonText,
	resolveClineModelDisplayName,
} from "@/components/detail-panels/cline-model-picker-options";
import { ExternalIssueBadge } from "@/components/external-issue-badge";
import { PrBadge } from "@/components/pr-badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeAgentId, RuntimeTaskSessionSummary, RuntimeTaskTokenUsage } from "@/runtime/types";
import { useTaskWorkspaceSnapshotValue } from "@/stores/workspace-metadata-store";
import type { BoardCard as BoardCardModel, BoardColumnId } from "@/types";
import { getTaskAutoReviewCancelButtonLabel } from "@/types";
import { cardKind, getTaskCompletionPolicyBadgeLabel } from "@/utils/card-completion-policy";
import { formatCostUsd, formatTokenCount, realWorkTokenCount, totalTokenCount } from "@/utils/format-token-count";
import { formatPathForDisplay } from "@/utils/path-display";
import { useMeasure } from "@/utils/react-use";
import {
	clampTextWithInlineSuffix,
	getTaskPromptDescription,
	normalizePromptForDisplay,
	truncateTaskPromptLabel,
} from "@/utils/task-prompt";
import { DEFAULT_TEXT_MEASURE_FONT, measureTextWidth, readElementFontShorthand } from "@/utils/text-measure";

interface CardSessionActivity {
	dotColor: string;
	text: string;
}

const SESSION_ACTIVITY_COLOR = {
	thinking: "var(--color-status-blue)",
	success: "var(--color-status-green)",
	waiting: "var(--color-status-gold)",
	error: "var(--color-status-red)",
	warning: "var(--color-status-orange)",
	muted: "var(--color-text-tertiary)",
	secondary: "var(--color-text-secondary)",
} as const;

const DESCRIPTION_COLLAPSE_LINES = 3;
const DESCRIPTION_EXPANDED_MAX_LINES = 10;
const DESCRIPTION_EXPAND_LABEL = "See more";
const DESCRIPTION_COLLAPSE_LABEL = "Less";
const DESCRIPTION_COLLAPSE_SUFFIX = `… ${DESCRIPTION_EXPAND_LABEL}`;
const DESCRIPTION_EXPANDED_SUFFIX = `… ${DESCRIPTION_COLLAPSE_LABEL}`;

// Short display names for the handful of Claude model ids a card's agentModel
// override can carry. An id absent here (another provider's, or a future
// Claude model) falls back to the raw id rather than hiding it.
const KNOWN_MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
	"claude-opus-4-8": "Opus 4.8",
	"claude-sonnet-5": "Sonnet 5",
	"claude-haiku-4-5": "Haiku 4.5",
};

function resolveAgentModelDisplayName(agentId: RuntimeAgentId | null, modelId: string): string {
	if (agentId === "cline") {
		return resolveClineModelDisplayName(modelId);
	}
	return KNOWN_MODEL_DISPLAY_NAMES[modelId] ?? modelId;
}

function reconstructTaskWorktreeDisplayPath(
	taskId: string,
	workspacePath: string | null | undefined,
	worktreesRoot: string | null | undefined,
): string | null {
	if (!workspacePath) {
		return null;
	}
	try {
		const path = buildTaskWorktreeDisplayPath(taskId, workspacePath, worktreesRoot ?? undefined);
		// With a real root the path is absolute; abbreviate the home prefix for display.
		return worktreesRoot ? formatPathForDisplay(path) : path;
	} catch {
		return null;
	}
}

function extractToolInputSummaryFromActivityText(activityText: string, toolName: string): string | null {
	const escapedToolName = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = activityText.match(
		new RegExp(`^(?:Using|Completed|Failed|Calling)\\s+${escapedToolName}(?::\\s*(.+))?$`),
	);
	if (!match) {
		return null;
	}
	const rawSummary = match[1]?.trim() ?? "";
	if (!rawSummary) {
		return null;
	}
	if (activityText.startsWith("Failed ")) {
		const [operationSummary] = rawSummary.split(": ");
		return operationSummary?.trim() || null;
	}
	return rawSummary;
}

function parseToolCallFromActivityText(
	activityText: string,
): { toolName: string; toolInputSummary: string | null } | null {
	const match = activityText.match(/^(?:Using|Completed|Failed|Calling)\s+([^:()]+?)(?::\s*(.+))?$/);
	if (!match?.[1]) {
		return null;
	}
	const toolName = match[1].trim();
	if (!toolName) {
		return null;
	}
	const rawSummary = match[2]?.trim() ?? "";
	if (!rawSummary) {
		return { toolName, toolInputSummary: null };
	}
	if (activityText.startsWith("Failed ")) {
		const [operationSummary] = rawSummary.split(": ");
		return {
			toolName,
			toolInputSummary: operationSummary?.trim() || null,
		};
	}
	return {
		toolName,
		toolInputSummary: rawSummary,
	};
}

function resolveToolCallLabel(
	activityText: string | undefined,
	toolName: string | null,
	toolInputSummary: string | null,
): string | null {
	if (toolName) {
		const parsedSummary = extractToolInputSummaryFromActivityText(activityText ?? "", toolName);
		if (!toolInputSummary && !parsedSummary) {
			return null;
		}
		return formatClineToolCallLabel(toolName, toolInputSummary ?? parsedSummary);
	}
	if (!activityText) {
		return null;
	}
	const parsed = parseToolCallFromActivityText(activityText);
	if (!parsed) {
		return null;
	}
	return formatClineToolCallLabel(parsed.toolName, parsed.toolInputSummary);
}

function isCardCreditLimitError(summary: RuntimeTaskSessionSummary | undefined): boolean {
	if (!summary) {
		return false;
	}
	if (summary.state !== "awaiting_review" && summary.state !== "failed" && summary.state !== "interrupted") {
		return false;
	}
	return summary.latestHookActivity?.notificationType === "credit_limit";
}

function isCardNeedsInput(summary: RuntimeTaskSessionSummary | undefined): boolean {
	return summary?.state === "awaiting_review" && summary.reviewReason === "needs_input";
}

function getCardSessionActivity(summary: RuntimeTaskSessionSummary | undefined): CardSessionActivity | null {
	if (!summary) {
		return null;
	}
	if (isCardCreditLimitError(summary)) {
		return { dotColor: SESSION_ACTIVITY_COLOR.warning, text: "Out of credits" };
	}
	if (isCardNeedsInput(summary)) {
		// The agent stopped to ask, not to hand off. Show its question if it left one.
		const question = summary.latestHookActivity?.finalMessage?.trim();
		return { dotColor: SESSION_ACTIVITY_COLOR.thinking, text: question || "Needs your input" };
	}
	const hookActivity = summary.latestHookActivity;
	const activityText = hookActivity?.activityText?.trim();
	const toolName = hookActivity?.toolName?.trim() ?? null;
	const toolInputSummary = hookActivity?.toolInputSummary?.trim() ?? null;
	const finalMessage = hookActivity?.finalMessage?.trim();
	const hookEventName = hookActivity?.hookEventName?.trim() ?? null;
	if (summary.state === "awaiting_review" && finalMessage) {
		return { dotColor: SESSION_ACTIVITY_COLOR.success, text: finalMessage };
	}
	if (
		finalMessage &&
		!toolName &&
		(hookEventName === "assistant_delta" || hookEventName === "agent_end" || hookEventName === "turn_start")
	) {
		return {
			dotColor: summary.state === "running" ? SESSION_ACTIVITY_COLOR.thinking : SESSION_ACTIVITY_COLOR.success,
			text: finalMessage,
		};
	}
	if (activityText) {
		let dotColor: string =
			summary.state === "failed" ? SESSION_ACTIVITY_COLOR.error : SESSION_ACTIVITY_COLOR.thinking;
		let text = activityText;
		const toolCallLabel = resolveToolCallLabel(activityText, toolName, toolInputSummary);
		if (toolCallLabel) {
			if (text.startsWith("Failed ")) {
				dotColor = SESSION_ACTIVITY_COLOR.error;
			}
			return {
				dotColor,
				text: toolCallLabel,
			};
		}
		if (text.startsWith("Final: ")) {
			dotColor = SESSION_ACTIVITY_COLOR.success;
			text = text.slice(7);
		} else if (text.startsWith("Agent: ")) {
			text = text.slice(7);
		} else if (text.startsWith("Waiting for approval")) {
			dotColor = SESSION_ACTIVITY_COLOR.waiting;
		} else if (text.startsWith("Waiting for review")) {
			dotColor = SESSION_ACTIVITY_COLOR.success;
		} else if (text.startsWith("Failed ")) {
			dotColor = SESSION_ACTIVITY_COLOR.error;
		} else if (text === "Agent active" || text === "Working on task" || text.startsWith("Resumed")) {
			return { dotColor: SESSION_ACTIVITY_COLOR.thinking, text: "Thinking..." };
		}
		return { dotColor, text };
	}
	if (summary.state === "failed") {
		const failedText = finalMessage ?? activityText ?? "Task failed to start";
		return { dotColor: SESSION_ACTIVITY_COLOR.error, text: failedText };
	}
	if (summary.state === "awaiting_review") {
		return { dotColor: SESSION_ACTIVITY_COLOR.success, text: "Waiting for review" };
	}
	if (summary.state === "running") {
		return { dotColor: SESSION_ACTIVITY_COLOR.thinking, text: "Thinking..." };
	}
	return null;
}

export function BoardCard({
	card,
	index,
	columnId,
	sessionSummary,
	tokenUsage = null,
	selected = false,
	onClick,
	onStart,
	onMoveToTrash,
	onRestoreFromTrash,
	onSaveTitle,
	onCommit,
	onOpenPr,
	onCancelAutomaticAction,
	isCommitLoading = false,
	isOpenPrLoading = false,
	isMoveToTrashLoading = false,
	onDependencyPointerDown,
	onDependencyPointerEnter,
	isDependencySource = false,
	isDependencyTarget = false,
	isDependencyLinking = false,
	workspacePath,
	taskWorktreesRoot,
	defaultClineModelId = null,
	defaultAgentId = null,
}: {
	card: BoardCardModel;
	index: number;
	columnId: BoardColumnId;
	sessionSummary?: RuntimeTaskSessionSummary;
	tokenUsage?: RuntimeTaskTokenUsage | null;
	selected?: boolean;
	onClick?: () => void;
	onStart?: (taskId: string) => void;
	onMoveToTrash?: (taskId: string) => void;
	onRestoreFromTrash?: (taskId: string) => void;
	onSaveTitle?: (taskId: string, title: string) => void;
	onCommit?: (taskId: string) => void;
	onOpenPr?: (taskId: string) => void;
	onCancelAutomaticAction?: (taskId: string) => void;
	isCommitLoading?: boolean;
	isOpenPrLoading?: boolean;
	isMoveToTrashLoading?: boolean;
	onDependencyPointerDown?: (taskId: string, event: MouseEvent<HTMLElement>) => void;
	onDependencyPointerEnter?: (taskId: string) => void;
	isDependencySource?: boolean;
	isDependencyTarget?: boolean;
	isDependencyLinking?: boolean;
	workspacePath?: string | null;
	taskWorktreesRoot?: string | null;
	defaultClineModelId?: string | null;
	defaultAgentId?: RuntimeAgentId | null;
}): React.ReactElement {
	const [isHovered, setIsHovered] = useState(false);
	const [isEditingTitle, setIsEditingTitle] = useState(false);
	const [draftTitle, setDraftTitle] = useState(card.title);
	const titleInputRef = useRef<HTMLInputElement | null>(null);
	const titleEditCancelledRef = useRef(false);
	const [descriptionContainerRef, descriptionRect] = useMeasure<HTMLDivElement>();
	const descriptionRef = useRef<HTMLParagraphElement | null>(null);
	const [descriptionWidthFallback, setDescriptionWidthFallback] = useState(0);
	const [descriptionFont, setDescriptionFont] = useState(DEFAULT_TEXT_MEASURE_FONT);
	const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false);
	const reviewWorkspaceSnapshot = useTaskWorkspaceSnapshotValue(card.id);
	const isDoneCard = columnId === "done";
	const isTrashCard = columnId === "trash";
	const isCardInteractive = !isTrashCard;
	const descriptionWidth = descriptionRect.width > 0 ? descriptionRect.width : descriptionWidthFallback;
	const rawSessionActivity = useMemo(() => getCardSessionActivity(sessionSummary), [sessionSummary]);
	const lastSessionActivityRef = useRef<CardSessionActivity | null>(null);
	const lastSessionActivityCardIdRef = useRef<string | null>(null);
	if (lastSessionActivityCardIdRef.current !== card.id) {
		lastSessionActivityCardIdRef.current = card.id;
		lastSessionActivityRef.current = null;
	}
	if (rawSessionActivity) {
		lastSessionActivityRef.current = rawSessionActivity;
	}
	const sessionActivity = rawSessionActivity ?? lastSessionActivityRef.current;
	const displayTitle = useMemo(
		() => normalizePromptForDisplay(card.title) || truncateTaskPromptLabel(card.prompt),
		[card.prompt, card.title],
	);
	const displayDescription = useMemo(
		() => getTaskPromptDescription(card.prompt, displayTitle),
		[card.prompt, displayTitle],
	);

	useLayoutEffect(() => {
		if (descriptionRect.width > 0 || !displayDescription) {
			return;
		}
		const nextWidth = descriptionRef.current?.parentElement?.getBoundingClientRect().width ?? 0;
		if (nextWidth > 0 && nextWidth !== descriptionWidthFallback) {
			setDescriptionWidthFallback(nextWidth);
		}
	}, [descriptionRect.width, descriptionWidthFallback, displayDescription]);

	useLayoutEffect(() => {
		setDescriptionFont(readElementFontShorthand(descriptionRef.current, DEFAULT_TEXT_MEASURE_FONT));
	}, [descriptionWidth, displayDescription]);

	useEffect(() => {
		setIsDescriptionExpanded(false);
	}, [card.id, displayDescription]);

	useEffect(() => {
		setDraftTitle(card.title);
		setIsEditingTitle(false);
	}, [card.id, card.title]);

	useEffect(() => {
		if (!isEditingTitle) {
			return;
		}
		window.requestAnimationFrame(() => {
			titleInputRef.current?.focus();
			titleInputRef.current?.select();
		});
	}, [isEditingTitle]);

	const stopEvent = (event: MouseEvent<HTMLElement>) => {
		event.preventDefault();
		event.stopPropagation();
	};

	const submitTitle = () => {
		if (titleEditCancelledRef.current) {
			titleEditCancelledRef.current = false;
			return;
		}
		setIsEditingTitle(false);
		if (!onSaveTitle) {
			return;
		}
		const trimmed = draftTitle.trim();
		if (trimmed === card.title) {
			return;
		}
		onSaveTitle(card.id, trimmed);
	};

	const handleTitleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			event.preventDefault();
			event.stopPropagation();
			titleInputRef.current?.blur();
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			titleEditCancelledRef.current = true;
			setDraftTitle(card.title);
			setIsEditingTitle(false);
			titleInputRef.current?.blur();
		}
	};

	const isDescriptionMeasured = descriptionRect.width > 0;

	const descriptionDisplay = useMemo(() => {
		if (!displayDescription) {
			return {
				collapsed: { text: "", isTruncated: false },
				expanded: { text: "", isTruncated: false },
			};
		}
		if (descriptionWidth <= 0) {
			return {
				collapsed: { text: displayDescription, isTruncated: false },
				expanded: { text: displayDescription, isTruncated: false },
			};
		}
		const measure = (value: string) => measureTextWidth(value, descriptionFont);
		return {
			collapsed: clampTextWithInlineSuffix(displayDescription, {
				maxWidthPx: descriptionWidth,
				maxLines: DESCRIPTION_COLLAPSE_LINES,
				suffix: DESCRIPTION_COLLAPSE_SUFFIX,
				measureText: measure,
			}),
			expanded: clampTextWithInlineSuffix(displayDescription, {
				maxWidthPx: descriptionWidth,
				maxLines: DESCRIPTION_EXPANDED_MAX_LINES,
				suffix: DESCRIPTION_EXPANDED_SUFFIX,
				measureText: measure,
			}),
		};
	}, [descriptionFont, descriptionWidth, displayDescription]);

	const isCreditLimit = isCardCreditLimitError(sessionSummary);
	const needsInput = isCardNeedsInput(sessionSummary);
	const renderStatusMarker = () => {
		if (isCreditLimit) {
			return <AlertTriangle size={12} className="text-status-orange" />;
		}
		if (columnId === "in_progress") {
			if (sessionSummary?.state === "failed") {
				return <AlertCircle size={12} className="text-status-red" />;
			}
			return <Spinner size={12} />;
		}
		return null;
	};
	const statusMarker = renderStatusMarker();
	const showWorkspaceStatus = columnId === "in_progress" || columnId === "review" || isDoneCard || isTrashCard;
	const reviewWorkspacePath = reviewWorkspaceSnapshot
		? formatPathForDisplay(reviewWorkspaceSnapshot.path)
		: isTrashCard
			? reconstructTaskWorktreeDisplayPath(card.id, workspacePath, taskWorktreesRoot)
			: null;
	const reviewRefLabel = reviewWorkspaceSnapshot?.branch ?? reviewWorkspaceSnapshot?.headCommit?.slice(0, 8) ?? "HEAD";
	const reviewChangeSummary = reviewWorkspaceSnapshot
		? reviewWorkspaceSnapshot.changedFiles == null
			? null
			: {
					filesLabel: `${reviewWorkspaceSnapshot.changedFiles} ${reviewWorkspaceSnapshot.changedFiles === 1 ? "file" : "files"}`,
					additions: reviewWorkspaceSnapshot.additions ?? 0,
					deletions: reviewWorkspaceSnapshot.deletions ?? 0,
				}
		: null;
	const showReviewGitActions = columnId === "review" && (reviewWorkspaceSnapshot?.changedFiles ?? 0) > 0;
	const isAnyGitActionLoading = isCommitLoading || isOpenPrLoading;
	const cancelAutomaticActionLabel =
		!isTrashCard && card.autoReviewEnabled ? getTaskAutoReviewCancelButtonLabel(card.autoReviewMode) : null;
	const trashRestoreLabel =
		sessionSummary?.agentSessionLifecycle === "gone"
			? "Start fresh"
			: sessionSummary?.agentSessionLifecycle === "resumable"
				? "Resume"
				: "Restore";
	// The agent always renders, even for a card that never set an override —
	// falling back to the workspace's default agent so operators can see what a
	// card actually runs on, not just what it explicitly overrode.
	const effectiveAgentId = card.agentId ?? defaultAgentId ?? null;
	const agentLabel = useMemo(
		() => (effectiveAgentId ? (getRuntimeAgentCatalogEntry(effectiveAgentId)?.label ?? effectiveAgentId) : null),
		[effectiveAgentId],
	);
	const modelOverrideLabel = useMemo(() => {
		if (card.clineSettings === undefined) {
			return null;
		}
		const explicitReasoningLabel = card.clineSettings.reasoningEffort
			? formatClineReasoningEffortLabel(card.clineSettings.reasoningEffort)
			: !card.clineSettings.providerId && !card.clineSettings.modelId
				? "Default"
				: null;
		if (card.clineSettings.providerId && !card.clineSettings.modelId) {
			const providerLabel = `Provider: ${card.clineSettings.providerId}`;
			return explicitReasoningLabel ? `${providerLabel} (${explicitReasoningLabel})` : providerLabel;
		}
		const effectiveModelId = card.clineSettings.modelId ?? defaultClineModelId;
		if (!effectiveModelId) {
			return explicitReasoningLabel ? `Default model (${explicitReasoningLabel})` : null;
		}
		const modelName = resolveClineModelDisplayName(effectiveModelId);
		if (explicitReasoningLabel) {
			return `${modelName} (${explicitReasoningLabel})`;
		}
		const inheritedReasoningEffort = "";
		return formatClineSelectedModelButtonText({
			modelName,
			reasoningEffort: inheritedReasoningEffort,
			showReasoningEffort: Boolean(inheritedReasoningEffort),
		});
	}, [card.clineSettings, defaultClineModelId]);
	// Model source priority: the Cline picker's own structured override (already
	// resolved above) wins when present; otherwise the card's plain agentModel
	// override; otherwise a muted "default" once the agent itself is known — a
	// card that has never set anything model-specific still tells you it's
	// running the workspace default rather than showing nothing.
	const resolvedModelLabel = useMemo(() => {
		if (modelOverrideLabel) {
			return { text: modelOverrideLabel, isDefault: false };
		}
		if (card.agentModel) {
			return { text: resolveAgentModelDisplayName(effectiveAgentId, card.agentModel), isDefault: false };
		}
		if (effectiveAgentId) {
			return { text: "default", isDefault: true };
		}
		return null;
	}, [modelOverrideLabel, card.agentModel, effectiveAgentId]);
	const taskAgentSettings = useMemo(() => {
		if (!agentLabel && !resolvedModelLabel) {
			return null;
		}
		return { agentLabel, modelLabel: resolvedModelLabel };
	}, [agentLabel, resolvedModelLabel]);
	const isPlanCard = cardKind(card) === "plan";
	const completionPolicyBadgeLabel = getTaskCompletionPolicyBadgeLabel(card);
	// Cumulative token usage, derived on read from the agent's own transcript.
	// The headline counts only real conversational work (input + output); cache
	// lanes are excluded because re-read context dominates the raw total ~100×
	// and would make a card read far heavier than it is (see realWorkTokenCount).
	// A fresh card (unknown, or no work and no cost) shows nothing so the board
	// stays clean; the chip only appears once there is real work or a cost to
	// report. When the agent's model is priced, an estimated cost is appended
	// (`· $X.XX`); an unpriced model shows tokens alone rather than a wrong dollar
	// figure. The tooltip carries the full per-lane breakdown and the grand total
	// so the headline↔total gap is self-explaining vs ccusage-style tools.
	const tokenUsageChip = useMemo(() => {
		if (!tokenUsage) {
			return null;
		}
		const realWork = realWorkTokenCount(tokenUsage);
		const hasCost = tokenUsage.costUsd != null && tokenUsage.costUsd > 0;
		if (realWork <= 0 && !hasCost) {
			return null;
		}
		const costLabel = tokenUsage.costUsd != null ? ` · ${formatCostUsd(tokenUsage.costUsd)}` : "";
		return {
			label: `${formatTokenCount(realWork)}${costLabel}`,
			title:
				`${tokenUsage.inputTokens.toLocaleString()} in · ${tokenUsage.outputTokens.toLocaleString()} out · ` +
				`${tokenUsage.cacheReadTokens.toLocaleString()} cache read · ` +
				`${tokenUsage.cacheCreationTokens.toLocaleString()} cache write · ` +
				`${totalTokenCount(tokenUsage).toLocaleString()} total` +
				(tokenUsage.costUsd != null ? ` · ${formatCostUsd(tokenUsage.costUsd)} est.` : ""),
		};
	}, [tokenUsage]);

	const activeDescriptionDisplay = isDescriptionExpanded ? descriptionDisplay.expanded : descriptionDisplay.collapsed;

	return (
		<Draggable draggableId={card.id} index={index} isDragDisabled={false}>
			{(provided, snapshot) => {
				const isDragging = snapshot.isDragging;
				const draggableContent = (
					<div
						ref={provided.innerRef}
						{...provided.draggableProps}
						{...provided.dragHandleProps}
						className="kb-board-card-shell"
						data-task-id={card.id}
						data-column-id={columnId}
						data-selected={selected}
						onMouseDownCapture={(event) => {
							if (!isCardInteractive) {
								return;
							}
							if (isDependencyLinking) {
								event.preventDefault();
								event.stopPropagation();
								return;
							}
							if (!event.metaKey && !event.ctrlKey) {
								return;
							}
							const target = event.target as HTMLElement | null;
							if (target?.closest("button, a, input, textarea, [contenteditable='true']")) {
								return;
							}
							event.preventDefault();
							event.stopPropagation();
							onDependencyPointerDown?.(card.id, event);
						}}
						onClick={(event) => {
							if (!isCardInteractive) {
								return;
							}
							if (isDependencyLinking) {
								event.preventDefault();
								event.stopPropagation();
								return;
							}
							if (event.metaKey || event.ctrlKey) {
								return;
							}
							const target = event.target as HTMLElement | null;
							if (target?.closest("button, a, input, textarea, [contenteditable='true']")) {
								return;
							}
							if (!snapshot.isDragging && onClick) {
								onClick();
							}
						}}
						style={{
							...provided.draggableProps.style,
							marginBottom: 6,
							cursor: "grab",
						}}
						onMouseEnter={() => {
							setIsHovered(true);
							onDependencyPointerEnter?.(card.id);
						}}
						onMouseMove={() => {
							if (!isDependencyLinking) {
								return;
							}
							onDependencyPointerEnter?.(card.id);
						}}
						onMouseLeave={() => setIsHovered(false)}
					>
						<div
							className={cn(
								"rounded-md border border-border-bright bg-surface-2 p-2.5",
								isDoneCard && "border-status-green/50 bg-status-green/5",
								isCardInteractive && "cursor-pointer hover:bg-surface-3 hover:border-border-bright",
								isDoneCard && isCardInteractive && "hover:border-status-green/60 hover:bg-status-green/10",
								isDragging && "shadow-lg",
								isHovered && isCardInteractive && "bg-surface-3 border-border-bright",
								isDoneCard && isHovered && isCardInteractive && "border-status-green/60 bg-status-green/10",
								isDependencySource && "kb-board-card-dependency-source",
								isDependencyTarget && "kb-board-card-dependency-target",
							)}
						>
							{card.externalIssue || card.prUrl ? (
								<div className="mb-1 flex min-w-0 items-center gap-1.5" data-testid="board-card-meta-row">
									<ExternalIssueBadge issue={card.externalIssue} />
									<PrBadge card={card} />
								</div>
							) : null}
							<div className="flex items-center gap-2" style={{ minHeight: 24 }}>
								{statusMarker ? <div className="inline-flex items-center">{statusMarker}</div> : null}
								<div className="flex-1 min-w-0">
									{isEditingTitle ? (
										<input
											ref={titleInputRef}
											value={draftTitle}
											onChange={(event) => setDraftTitle(event.currentTarget.value)}
											onBlur={submitTitle}
											onKeyDown={handleTitleKeyDown}
											onMouseDown={(event) => {
												event.stopPropagation();
											}}
											className="h-7 w-full rounded-md border border-border-focus bg-surface-2 px-2 text-sm font-medium text-text-primary focus:outline-none"
										/>
									) : onSaveTitle ? (
										<div className="flex items-center gap-1 min-w-0">
											<span className="shrink-0 font-mono text-[10px] text-text-tertiary select-all">
												{card.id}
											</span>
											<p
												className={cn(
													"kb-line-clamp-1 m-0 min-w-0 font-medium text-sm",
													isTrashCard && "line-through text-text-tertiary",
												)}
											>
												{displayTitle}
											</p>
											<button
												type="button"
												aria-label="Edit task title"
												onMouseDown={stopEvent}
												onClick={(event) => {
													stopEvent(event);
													setDraftTitle(card.title);
													setIsEditingTitle(true);
												}}
												className={cn(
													"shrink-0 cursor-pointer rounded-sm p-0.5 text-text-tertiary hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
													isHovered ? "opacity-100" : "opacity-0",
												)}
											>
												<Pencil size={12} />
											</button>
										</div>
									) : (
										<div className="flex items-center gap-1 min-w-0">
											<span className="shrink-0 font-mono text-[10px] text-text-tertiary select-all">
												{card.id}
											</span>
											<p
												className={cn(
													"kb-line-clamp-1 m-0 min-w-0 font-medium text-sm",
													isTrashCard && "line-through text-text-tertiary",
												)}
											>
												{displayTitle}
											</p>
										</div>
									)}
								</div>
								{columnId === "backlog" ? (
									<Button
										icon={<Play size={14} />}
										variant="ghost"
										size="sm"
										aria-label="Start task"
										onMouseDown={stopEvent}
										onClick={(event) => {
											stopEvent(event);
											onStart?.(card.id);
										}}
									/>
								) : columnId === "review" ? (
									<Button
										icon={isMoveToTrashLoading ? <Spinner size={13} /> : <CheckCircle2 size={13} />}
										variant="ghost"
										size="sm"
										disabled={isMoveToTrashLoading}
										aria-label="Move task to done"
										onMouseDown={stopEvent}
										onClick={(event) => {
											stopEvent(event);
											onMoveToTrash?.(card.id);
										}}
									/>
								) : isDoneCard ? (
									<Button
										icon={isMoveToTrashLoading ? <Spinner size={13} /> : <Trash2 size={13} />}
										variant="ghost"
										size="sm"
										disabled={isMoveToTrashLoading}
										aria-label="Trash task"
										onMouseDown={stopEvent}
										onClick={(event) => {
											stopEvent(event);
											onMoveToTrash?.(card.id);
										}}
									/>
								) : isTrashCard ? (
									<Tooltip
										side="bottom"
										content={
											<>
												{trashRestoreLabel}
												<br />
												in new worktree
											</>
										}
									>
										<Button
											icon={
												sessionSummary?.agentSessionLifecycle === "gone" ? (
													<Play size={12} />
												) : (
													<RotateCcw size={12} />
												)
											}
											variant="ghost"
											size="sm"
											aria-label={`${trashRestoreLabel} task from archive`}
											onMouseDown={stopEvent}
											onClick={(event) => {
												stopEvent(event);
												onRestoreFromTrash?.(card.id);
											}}
										>
											{trashRestoreLabel}
										</Button>
									</Tooltip>
								) : null}
							</div>
							{needsInput ? (
								<div className="mt-1">
									<span className="inline-flex max-w-full items-center gap-1 rounded-md border border-status-blue/40 bg-status-blue/10 px-1.5 py-0.5 text-xs font-medium text-status-blue">
										<MessageCircleQuestion size={12} className="shrink-0" />
										<span className="truncate">Needs input</span>
									</span>
								</div>
							) : null}
							{displayDescription ? (
								<div ref={descriptionContainerRef}>
									<p
										ref={descriptionRef}
										className={cn(
											"text-sm leading-[1.4]",
											isTrashCard ? "text-text-tertiary" : "text-text-secondary",
											!isDescriptionMeasured && !isDescriptionExpanded && "line-clamp-3",
										)}
										style={{
											margin: "2px 0 0",
										}}
									>
										{activeDescriptionDisplay.isTruncated
											? activeDescriptionDisplay.text
											: displayDescription}
										{activeDescriptionDisplay.isTruncated ? (
											<>
												{"… "}
												<button
													type="button"
													className="inline cursor-pointer rounded-sm text-text-tertiary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [font:inherit]"
													aria-expanded={isDescriptionExpanded}
													aria-label={
														isDescriptionExpanded
															? "Collapse task description"
															: "Expand task description"
													}
													onMouseDown={stopEvent}
													onClick={(event) => {
														stopEvent(event);
														setIsDescriptionExpanded(!isDescriptionExpanded);
													}}
												>
													{isDescriptionExpanded ? DESCRIPTION_COLLAPSE_LABEL : DESCRIPTION_EXPAND_LABEL}
												</button>
											</>
										) : isDescriptionExpanded && descriptionDisplay.collapsed.isTruncated ? (
											<>
												{" "}
												<button
													type="button"
													className="inline cursor-pointer rounded-sm text-text-tertiary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [font:inherit]"
													aria-expanded={isDescriptionExpanded}
													aria-label="Collapse task description"
													onMouseDown={stopEvent}
													onClick={(event) => {
														stopEvent(event);
														setIsDescriptionExpanded(false);
													}}
												>
													{DESCRIPTION_COLLAPSE_LABEL}
												</button>
											</>
										) : null}
									</p>
								</div>
							) : null}
							{isPlanCard || taskAgentSettings || tokenUsageChip || completionPolicyBadgeLabel ? (
								<div className="mt-1 flex min-w-0 items-center gap-1.5" data-testid="board-card-chip-row">
									{isPlanCard ? (
										<span
											className={cn(
												"inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 font-mono text-xs",
												isTrashCard
													? "border-border text-text-tertiary bg-surface-1"
													: "border-status-purple/30 bg-status-purple/10 text-status-purple",
											)}
										>
											Plan
										</span>
									) : null}
									{taskAgentSettings ? (
										<span
											className={cn(
												"inline-flex min-w-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
												isTrashCard
													? "border-border text-text-tertiary bg-surface-1"
													: "border-status-blue/30 bg-status-blue/10 text-status-blue",
											)}
										>
											<Bot size={12} className="shrink-0" />
											<span className="truncate">
												{taskAgentSettings.agentLabel}
												{taskAgentSettings.agentLabel && taskAgentSettings.modelLabel ? " · " : null}
												{taskAgentSettings.modelLabel ? (
													<span
														className={cn(taskAgentSettings.modelLabel.isDefault && "text-text-tertiary")}
													>
														{taskAgentSettings.modelLabel.text}
													</span>
												) : null}
											</span>
										</span>
									) : null}
									{tokenUsageChip ? (
										<span
											className="shrink-0 font-mono text-[11px] text-text-tertiary"
											title={tokenUsageChip.title}
										>
											{tokenUsageChip.label}
										</span>
									) : null}
									{completionPolicyBadgeLabel ? (
										<span className="shrink-0 rounded-md border border-border bg-surface-1 px-1.5 py-0.5 font-mono text-[11px] text-text-tertiary">
											{completionPolicyBadgeLabel}
										</span>
									) : null}
								</div>
							) : null}
							{sessionActivity ? (
								<div
									className="flex gap-1.5 items-start mt-[6px]"
									style={{
										color: isTrashCard ? SESSION_ACTIVITY_COLOR.muted : undefined,
									}}
								>
									<span
										className="inline-block shrink-0 rounded-full"
										style={{
											width: 6,
											height: 6,
											backgroundColor: isTrashCard ? SESSION_ACTIVITY_COLOR.muted : sessionActivity.dotColor,
											marginTop: 4,
										}}
									/>
									<div className="min-w-0 flex-1">
										<p className="m-0 font-mono truncate" style={{ fontSize: 12 }}>
											{sessionActivity.text}
										</p>
									</div>
								</div>
							) : null}
							{showWorkspaceStatus && reviewWorkspacePath ? (
								<p
									className="font-mono"
									style={{
										margin: "4px 0 0",
										fontSize: 12,
										lineHeight: 1.4,
										whiteSpace: "normal",
										overflowWrap: "anywhere",
										color: isTrashCard ? SESSION_ACTIVITY_COLOR.muted : undefined,
									}}
								>
									{isTrashCard ? (
										<>
											{reviewWorkspacePath ? (
												<span
													style={{
														color: SESSION_ACTIVITY_COLOR.muted,
														textDecoration: "line-through",
													}}
												>
													{reviewWorkspacePath}
												</span>
											) : null}
										</>
									) : reviewWorkspaceSnapshot ? (
										<>
											<GitBranch
												size={10}
												style={{
													display: "inline",
													color: SESSION_ACTIVITY_COLOR.secondary,
													margin: "0px 4px 2px",
													verticalAlign: "middle",
												}}
											/>
											<span style={{ color: SESSION_ACTIVITY_COLOR.secondary }}>{reviewRefLabel}</span>
											{reviewChangeSummary ? (
												<>
													<span style={{ color: SESSION_ACTIVITY_COLOR.muted }}> (</span>
													<span style={{ color: SESSION_ACTIVITY_COLOR.muted }}>
														{reviewChangeSummary.filesLabel}
													</span>
													<span className="text-status-green"> +{reviewChangeSummary.additions}</span>
													<span className="text-status-red"> -{reviewChangeSummary.deletions}</span>
													<span style={{ color: SESSION_ACTIVITY_COLOR.muted }}>)</span>
												</>
											) : null}
										</>
									) : null}
								</p>
							) : null}
							{showReviewGitActions ? (
								<div className="flex gap-1.5 mt-1.5">
									<Button
										variant="primary"
										size="sm"
										icon={isCommitLoading ? <Spinner size={12} /> : undefined}
										disabled={isAnyGitActionLoading}
										style={{ flex: "1 1 0" }}
										onMouseDown={stopEvent}
										onClick={(event) => {
											stopEvent(event);
											onCommit?.(card.id);
										}}
									>
										Commit
									</Button>
									<Button
										variant="primary"
										size="sm"
										icon={isOpenPrLoading ? <Spinner size={12} /> : undefined}
										disabled={isAnyGitActionLoading}
										style={{ flex: "1 1 0" }}
										onMouseDown={stopEvent}
										onClick={(event) => {
											stopEvent(event);
											onOpenPr?.(card.id);
										}}
									>
										Open PR
									</Button>
								</div>
							) : null}
							{cancelAutomaticActionLabel && onCancelAutomaticAction ? (
								<Button
									size="sm"
									fill
									style={{ marginTop: 12 }}
									onMouseDown={stopEvent}
									onClick={(event) => {
										stopEvent(event);
										onCancelAutomaticAction(card.id);
									}}
								>
									{cancelAutomaticActionLabel}
								</Button>
							) : null}
						</div>
					</div>
				);

				if (isDragging && typeof document !== "undefined") {
					return createPortal(draggableContent, document.body);
				}
				return draggableContent;
			}}
		</Draggable>
	);
}
