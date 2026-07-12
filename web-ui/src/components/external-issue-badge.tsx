import { CircleDot, Github } from "lucide-react";
import type { MouseEvent, ReactElement } from "react";
import { cn } from "@/components/ui/cn";
import type { ExternalIssue } from "@/types";

const EXTERNAL_ISSUE_BADGE_CONFIG = {
	linear: {
		icon: CircleDot,
		className: "border-status-purple/30 bg-status-purple/10 text-status-purple",
	},
	github: {
		icon: Github,
		className: "border-border bg-surface-1 text-text-tertiary",
	},
} as const;

export function ExternalIssueBadge({
	issue,
	className,
}: {
	issue?: ExternalIssue;
	className?: string;
}): ReactElement | null {
	if (!issue) {
		return null;
	}
	const config = EXTERNAL_ISSUE_BADGE_CONFIG[issue.provider];
	const Icon = config.icon;
	const badgeClassName = cn(
		"inline-flex min-w-0 shrink items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
		config.className,
		className,
	);
	const content = (
		<>
			<Icon size={14} className="shrink-0" />
			<span className="min-w-0 truncate">{issue.key}</span>
		</>
	);
	const stopPropagation = (event: MouseEvent<HTMLElement>) => {
		event.stopPropagation();
	};

	if (!issue.url) {
		return (
			<span className={badgeClassName} onMouseDown={stopPropagation}>
				{content}
			</span>
		);
	}

	return (
		<a
			href={issue.url}
			target="_blank"
			rel="noopener noreferrer"
			className={badgeClassName}
			onMouseDown={stopPropagation}
			onClick={stopPropagation}
		>
			{content}
		</a>
	);
}
