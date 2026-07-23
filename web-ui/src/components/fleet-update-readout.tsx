// One-click "update this instance" pill for the sidebar title bar. Consumer boards
// running the shared vendor build can fall behind the fork's main; this offers to
// pull the latest build and restart, but only while no card is mid-session.
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { useFleetUpdateStatus } from "@/hooks/use-fleet-update-status";

function inProgressTitle(inProgressCount: number): string {
	return `Can't restart while ${inProgressCount} card${inProgressCount === 1 ? "" : "s"} in progress`;
}

export function FleetUpdateReadout({ className }: { className?: string }): React.ReactElement | null {
	const { status, phase, apply } = useFleetUpdateStatus();

	if (phase === "applying" || phase === "restarting") {
		return (
			<span
				data-testid="fleet-update-readout-updating"
				className={cn("flex items-center gap-1.5 text-xs text-text-secondary", className)}
			>
				<Spinner size={12} />
				Updating…
			</span>
		);
	}

	if (phase === "restart-timed-out") {
		return (
			<span data-testid="fleet-update-readout-timed-out" className={cn("text-xs text-status-orange", className)}>
				Still restarting — check back soon
			</span>
		);
	}

	if (!status || status.status.mode !== "vendor" || !status.status.updateAvailable) {
		return null;
	}

	const blocked = status.inProgressCount > 0;

	return (
		<Button
			aria-label="Apply fleet update"
			variant="ghost"
			size="sm"
			icon={<RefreshCw size={14} />}
			disabled={blocked}
			onClick={apply}
			title={blocked ? inProgressTitle(status.inProgressCount) : undefined}
			className={cn("shrink-0", className)}
		>
			Update available
		</Button>
	);
}
