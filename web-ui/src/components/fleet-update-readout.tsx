// One-click "update this instance" indicator for the sidebar title bar. Consumer
// boards running the shared vendor build can fall behind the fork's main; this
// offers to pull the latest build and restart, but only while no card is
// mid-session. Renders nothing when there's nothing to do, and a fixed-size icon
// otherwise so its presence/absence never reflows the rest of the title bar.
import * as Popover from "@radix-ui/react-popover";
import { AlertTriangle, ArrowUpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { useFleetUpdateStatus } from "@/hooks/use-fleet-update-status";

const POPOVER_CONTENT_CLASSNAME =
	"z-50 w-64 rounded-md border border-border-bright bg-surface-1 p-3 text-xs text-text-secondary shadow-lg";

function inProgressTitle(inProgressCount: number): string {
	return `Can't restart while ${inProgressCount} card${inProgressCount === 1 ? "" : "s"} in progress`;
}

function shortSha(sha: string | null): string {
	return sha ? sha.slice(0, 7) : "unknown";
}

function formatCheckedAt(lastCheckedAt: number | null): string {
	if (lastCheckedAt === null) {
		return "not checked yet";
	}
	const seconds = Math.max(0, Math.round((Date.now() - lastCheckedAt) / 1000));
	if (seconds < 60) {
		return "checked just now";
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `checked ${minutes}m ago`;
	}
	const hours = Math.round(minutes / 60);
	return `checked ${hours}h ago`;
}

function UpdatePopover({
	triggerLabel,
	triggerTestId,
	icon,
	children,
	className,
}: {
	triggerLabel: string;
	triggerTestId?: string;
	icon: React.ReactNode;
	children: React.ReactNode;
	className?: string;
}): React.ReactElement {
	return (
		<Popover.Root>
			<Popover.Trigger asChild>
				<Button
					aria-label={triggerLabel}
					data-testid={triggerTestId}
					variant="ghost"
					size="sm"
					icon={icon}
					className={cn("shrink-0", className)}
				/>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content align="end" sideOffset={6} className={POPOVER_CONTENT_CLASSNAME}>
					{children}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

export function FleetUpdateReadout({ className }: { className?: string }): React.ReactElement | null {
	const { status, phase, apply, lastCheckedAt } = useFleetUpdateStatus();

	if (phase === "applying" || phase === "restarting") {
		return (
			<UpdatePopover
				triggerLabel="Fleet update in progress"
				triggerTestId="fleet-update-readout-updating"
				icon={<Spinner size={14} />}
				className={className}
			>
				<div className="flex items-center gap-1.5 text-text-primary">
					<Spinner size={12} />
					{phase === "applying" ? "Updating…" : "Restarting…"}
				</div>
			</UpdatePopover>
		);
	}

	if (phase === "restart-timed-out") {
		return (
			<UpdatePopover
				triggerLabel="Fleet update status"
				triggerTestId="fleet-update-readout-timed-out"
				icon={<AlertTriangle size={14} className="text-status-orange" />}
				className={className}
			>
				<div className="text-status-orange">Still restarting — check back soon.</div>
				<div className="mt-1 text-text-tertiary">If this doesn't clear up, reload the page manually.</div>
			</UpdatePopover>
		);
	}

	if (!status || status.status.mode !== "vendor" || !status.status.updateAvailable) {
		return null;
	}

	const blocked = status.inProgressCount > 0;

	return (
		<UpdatePopover
			triggerLabel="Fleet update available"
			icon={<ArrowUpCircle size={16} className="text-status-blue" />}
			className={className}
		>
			<div className="space-y-2">
				<div className="font-medium text-text-primary">Update available</div>
				<div className="tabular-nums text-text-secondary">
					{shortSha(status.status.current)} → {shortSha(status.status.latest)}
				</div>
				<div className="text-text-tertiary">{formatCheckedAt(lastCheckedAt)}</div>
				<Button aria-label="Apply fleet update" variant="primary" size="sm" fill disabled={blocked} onClick={apply}>
					Update
				</Button>
				{blocked ? <div className="text-status-orange">{inProgressTitle(status.inProgressCount)}</div> : null}
			</div>
		</UpdatePopover>
	);
}
