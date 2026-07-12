import { FileText } from "lucide-react";
import { type MouseEvent, type ReactElement, useCallback, useState } from "react";

import { ClineMarkdownContent } from "@/components/detail-panels/cline-markdown-content";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import type { BoardCard } from "@/types";

type DesignDocBadgeCard = Pick<BoardCard, "id" | "externalIssue">;

export function DesignDocBadge({
	card,
	workspaceId,
	workspacePath,
	className,
}: {
	card: DesignDocBadgeCard;
	workspaceId: string | null;
	workspacePath?: string | null;
	className?: string;
}): ReactElement | null {
	const [isOpen, setIsOpen] = useState(false);
	const externalIssueKey = card.externalIssue?.key;
	const query = useTrpcQuery({
		enabled: Boolean(workspaceId && workspacePath),
		queryFn: useCallback(async () => {
			const trpc = getRuntimeTrpcClient(workspaceId);
			return await trpc.workspace.getDesignDoc.query({
				taskId: card.id,
				...(externalIssueKey ? { externalIssueKey } : {}),
			});
		}, [card.id, externalIssueKey, workspaceId]),
	});

	if (!query.data?.exists || query.data.content === undefined) {
		return null;
	}

	const stopPropagation = (event: MouseEvent<HTMLElement>) => {
		event.stopPropagation();
	};

	return (
		<>
			<button
				type="button"
				className={cn(
					"inline-flex min-w-0 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-status-blue/30 bg-status-blue/10 px-1.5 py-0.5 text-xs text-status-blue hover:bg-status-blue/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
					className,
				)}
				onMouseDown={stopPropagation}
				onClick={(event) => {
					stopPropagation(event);
					setIsOpen(true);
				}}
			>
				<FileText size={14} className="shrink-0" />
				<span className="min-w-0 truncate">Design</span>
			</button>
			<Dialog open={isOpen} onOpenChange={setIsOpen} contentClassName="max-w-3xl" contentAriaDescribedBy={undefined}>
				<DialogHeader title="Design Doc" icon={<FileText size={16} />} />
				<DialogBody className="max-h-[72vh] bg-surface-1">
					<ClineMarkdownContent content={query.data.content} />
				</DialogBody>
			</Dialog>
		</>
	);
}
