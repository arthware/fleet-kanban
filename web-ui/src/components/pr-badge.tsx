import { GitMerge, GitPullRequest, GitPullRequestArrow, GitPullRequestClosed } from "lucide-react";
import type { MouseEvent, ReactElement } from "react";
import { cn } from "@/components/ui/cn";
import type { BoardCard } from "@/types";

type PrBadgeCard = Pick<BoardCard, "prNumber" | "prState" | "prUrl">;

const PR_BADGE_STATE_CONFIG = {
	open: {
		icon: GitPullRequestArrow,
		className: "border-status-green/30 bg-status-green/10 text-status-green",
	},
	merged: {
		icon: GitMerge,
		className: "border-status-purple/30 bg-status-purple/10 text-status-purple",
	},
	closed: {
		icon: GitPullRequestClosed,
		className: "border-status-red/30 bg-status-red/10 text-status-red",
	},
	unknown: {
		icon: GitPullRequest,
		className: "border-border bg-surface-1 text-text-tertiary",
	},
} as const;

export function getPrBadgeLabel(card: PrBadgeCard): string {
	return card.prNumber != null ? `PR #${card.prNumber}` : "PR";
}

export function PrBadge({ card, className }: { card: PrBadgeCard; className?: string }): ReactElement | null {
	if (!card.prUrl) {
		return null;
	}
	const state = card.prState ?? "unknown";
	const config = PR_BADGE_STATE_CONFIG[state];
	const Icon = config.icon;
	const label = getPrBadgeLabel(card);
	const stopPropagation = (event: MouseEvent<HTMLAnchorElement>) => {
		event.stopPropagation();
	};

	return (
		<a
			href={card.prUrl}
			target="_blank"
			rel="noopener noreferrer"
			className={cn(
				"inline-flex min-w-0 shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
				config.className,
				className,
			)}
			onMouseDown={stopPropagation}
			onClick={stopPropagation}
		>
			<Icon size={14} className="shrink-0" />
			<span className={cn("min-w-0 truncate", state === "closed" && "line-through")}>{label}</span>
		</a>
	);
}
