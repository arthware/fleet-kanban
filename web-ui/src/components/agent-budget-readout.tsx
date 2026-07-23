// Compact remaining-agent-budget readout for the sidebar title bar — one pill per
// provider (Claude / Codex / Cursor), colored by its worst_remaining_percent so the
// operator can see at a glance when a provider is running low without running
// `fleet budget` in a terminal.
import { cn } from "@/components/ui/cn";
import type { RuntimeAgentBudgetProvider, RuntimeAgentBudgetResponse } from "@/runtime/types";

const PROVIDER_LABELS: Record<string, string> = {
	claude: "Claude",
	codex: "Codex",
	cursor: "Cursor",
};

const CRITICAL_THRESHOLD_PERCENT = 10;
const LOW_THRESHOLD_PERCENT = 25;
// A stale local read (e.g. Codex only refreshes on its own turns) still shows a
// number, but a "~" flags it as possibly out of date past this age.
const STALE_THRESHOLD_SECONDS = 60 * 60;

function providerLabel(provider: string): string {
	return PROVIDER_LABELS[provider] ?? provider;
}

export function agentBudgetHealthClassName(remainingPercent: number | null): string {
	if (remainingPercent === null) {
		return "text-text-tertiary";
	}
	if (remainingPercent < CRITICAL_THRESHOLD_PERCENT) {
		return "text-status-red";
	}
	if (remainingPercent < LOW_THRESHOLD_PERCENT) {
		return "text-status-orange";
	}
	return "text-status-green";
}

function AgentBudgetPill({ provider }: { provider: RuntimeAgentBudgetProvider }): React.ReactElement {
	const isStale = provider.staleSeconds !== null && provider.staleSeconds > STALE_THRESHOLD_SECONDS;
	const title = provider.windows.map((w) => `${w.name}: ${w.remainingPercent ?? "?"}%`).join(" · ");

	let displayPercent = provider.worstRemainingPercent;
	let weekSuffix = "";

	if (provider.provider === "claude") {
		const h5Window = provider.windows.find((w) => w.name === "5h");
		const weekWindow = provider.windows.find((w) => w.name === "week");

		if (h5Window && weekWindow) {
			displayPercent = h5Window.remainingPercent;
			if (weekWindow.remainingPercent !== null && weekWindow.remainingPercent < 20) {
				weekSuffix = ` · wk ${Math.round(weekWindow.remainingPercent)}%`;
			}
		}
	}

	return (
		<span
			data-testid={`agent-budget-pill-${provider.provider}`}
			title={title}
			className={cn("font-medium whitespace-nowrap", agentBudgetHealthClassName(displayPercent))}
		>
			{providerLabel(provider.provider)} {displayPercent === null ? "?" : Math.round(displayPercent)}%{weekSuffix}
			{isStale ? <span className="text-text-tertiary">~</span> : null}
		</span>
	);
}

export function AgentBudgetReadout({
	budget,
	className,
}: {
	budget: RuntimeAgentBudgetResponse | null;
	className?: string;
}): React.ReactElement | null {
	if (!budget || !budget.available || budget.providers.length === 0) {
		return null;
	}

	return (
		<div
			data-testid="agent-budget-readout"
			className={cn("flex items-center gap-1.5 text-xs text-text-secondary", className)}
		>
			{budget.providers.map((provider, index) => (
				<span key={provider.provider} className="flex items-center gap-1.5">
					{index > 0 ? <span className="text-text-tertiary">·</span> : null}
					<AgentBudgetPill provider={provider} />
				</span>
			))}
		</div>
	);
}
