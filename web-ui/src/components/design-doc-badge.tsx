import { FileText } from "lucide-react";
import { type MouseEvent, type ReactElement, useState } from "react";

import { ClineMarkdownContent } from "@/components/detail-panels/cline-markdown-content";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import { type TaskDesignDocCard, useTaskDesignDoc } from "@/hooks/use-task-design-doc";
import type { RuntimeDesignDocResponse } from "@/runtime/types";
import type { UseTrpcQueryResult } from "@/runtime/use-trpc-query";

export function DesignDocBadge({
	card,
	workspaceId,
	workspacePath,
	designDoc: preloadedDesignDoc,
	className,
}: {
	card: TaskDesignDocCard;
	workspaceId: string | null;
	workspacePath?: string | null;
	// A parent that already runs `useTaskDesignDoc` (e.g. the board card, which
	// also drives the "Implement here" action) passes its result here so the doc
	// is fetched once per card. Standalone callers omit it and the badge self-queries.
	designDoc?: UseTrpcQueryResult<RuntimeDesignDocResponse>;
	className?: string;
}): ReactElement | null {
	const [isOpen, setIsOpen] = useState(false);
	const selfDesignDoc = useTaskDesignDoc({
		card,
		workspaceId,
		workspacePath,
		enabled: preloadedDesignDoc === undefined,
	});
	const designDoc = preloadedDesignDoc ?? selfDesignDoc;

	if (!designDoc.data?.exists || designDoc.data.content === undefined) {
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
					<ClineMarkdownContent content={designDoc.data.content} />
				</DialogBody>
			</Dialog>
		</>
	);
}
