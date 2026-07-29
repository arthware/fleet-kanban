import { History, Play } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";

import { MarkdownContent } from "@/components/detail-panels/markdown-content";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import type { RuntimeTaskChatMessage, RuntimeTaskSessionSummary } from "@/runtime/types";

/** What a transcript load resolved to: the CLI's persisted conversation, if any. */
export interface AgentTranscriptLoadResult {
	/** True when a transcript file was located on disk for this session. */
	present: boolean;
	messages: RuntimeTaskChatMessage[];
}

export interface AgentTranscriptPanelProps {
	taskId: string;
	summary: RuntimeTaskSessionSummary | null;
	/**
	 * Loads the persisted transcript for a task. Returns `null` on failure. Kept
	 * as a prop (not an inline fetch) so the detail view injects the runtime
	 * query and tests inject a fake, mirroring the Cline chat panel's loader.
	 */
	onLoadTranscript: (taskId: string) => Promise<AgentTranscriptLoadResult | null>;
	/** Resume the ended session (only meaningful when the session is resumable). */
	onResume?: () => void;
	isResumeLoading?: boolean;
}

type LoadState =
	| { status: "loading" }
	| { status: "loaded"; present: boolean; messages: RuntimeTaskChatMessage[] }
	| { status: "error" };

/**
 * Read-only view of an ended agent session's conversation, rendered from the
 * CLI's own on-disk transcript. This is the durable "observe" surface: when a
 * task's live PTY is gone, the detail pane shows this instead of a blank
 * terminal. Agent-agnostic — it renders whatever `onLoadTranscript` resolves,
 * whether the session was Claude or Codex.
 */
export function AgentTranscriptPanel({
	taskId,
	summary,
	onLoadTranscript,
	onResume,
	isResumeLoading = false,
}: AgentTranscriptPanelProps): ReactElement {
	const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });

	useEffect(() => {
		let cancelled = false;
		setLoadState({ status: "loading" });
		void onLoadTranscript(taskId).then((result) => {
			if (cancelled) {
				return;
			}
			if (!result) {
				setLoadState({ status: "error" });
				return;
			}
			setLoadState({ status: "loaded", present: result.present, messages: result.messages });
		});
		return () => {
			cancelled = true;
		};
	}, [taskId, onLoadTranscript]);

	const canResume = summary?.agentSessionLifecycle === "resumable" && Boolean(onResume);

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-0">
			<div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
				<span className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
					<History size={12} />
					Session ended · read-only transcript
				</span>
				{canResume ? (
					<Button
						variant="primary"
						size="sm"
						icon={isResumeLoading ? <Spinner size={12} /> : <Play size={12} />}
						disabled={isResumeLoading}
						onClick={onResume}
					>
						Resume session
					</Button>
				) : null}
			</div>
			<AgentTranscriptBody loadState={loadState} canResume={canResume} />
		</div>
	);
}

function AgentTranscriptBody({ loadState, canResume }: { loadState: LoadState; canResume: boolean }): ReactElement {
	const scrollRef = useRef<HTMLDivElement | null>(null);

	if (loadState.status === "loading") {
		return (
			<div className="flex flex-1 items-center justify-center text-text-tertiary">
				<Spinner size={18} />
			</div>
		);
	}

	if (loadState.status === "error") {
		return <EmptyTranscriptState message="Could not load this session's conversation." />;
	}

	if (loadState.messages.length === 0) {
		return (
			<EmptyTranscriptState
				message={
					loadState.present
						? "No conversation was recorded for this session."
						: canResume
							? "This session's saved conversation could not be read, but it can still be resumed."
							: "This session's conversation is no longer on disk."
				}
			/>
		);
	}

	return (
		<div
			ref={scrollRef}
			className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto px-2 py-3"
		>
			{loadState.messages.map((message) => (
				<TranscriptMessageItem key={message.id} message={message} />
			))}
		</div>
	);
}

function TranscriptMessageItem({ message }: { message: RuntimeTaskChatMessage }): ReactElement {
	const roleLabel = message.meta?.displayRole ?? message.role;
	return (
		<div
			className={cn(
				"rounded-md border px-3 py-2 text-sm",
				message.role === "user"
					? "border-border-bright bg-surface-2 text-text-primary"
					: "border-border bg-surface-1 text-text-secondary",
			)}
		>
			<div className="mb-1 text-[11px] font-medium uppercase text-text-tertiary">{roleLabel}</div>
			<MarkdownContent content={message.content} />
		</div>
	);
}

function EmptyTranscriptState({ message }: { message: string }): ReactElement {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center text-text-tertiary">
			<History size={28} />
			<p className="m-0 max-w-xs text-sm">{message}</p>
		</div>
	);
}
