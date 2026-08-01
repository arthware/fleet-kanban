// Compact remaining-agent-budget readout for the sidebar title bar — one pill per
// provider (Claude / Codex / Cursor), colored by its worst_remaining_percent so the
// operator can see at a glance when a provider is running low without running
// `fleet budget` in a terminal.
import { cn } from "@/components/ui/cn";
import type { RuntimeAgentBudgetProvider, RuntimeAgentBudgetResponse, RuntimeAgentBudgetWindow } from "@/runtime/types";

const PROVIDER_LABELS: Record<string, string> = {
	claude: "Claude",
	codex: "Codex",
	cursor: "Cursor",
};

const CRITICAL_THRESHOLD_PERCENT = 10;
const LOW_THRESHOLD_PERCENT = 25;
// A stale local read (e.g. Codex only refreshes on its own turns) still shows a
// number, but a dot flags it as possibly out of date past this age.
const STALE_THRESHOLD_SECONDS = 60 * 60;

function providerLabel(provider: string): string {
	return PROVIDER_LABELS[provider] ?? provider;
}

// Mirrors fleet-cli/budget.py's `_fmt_reset` so the tooltip matches what `fleet budget` prints.
export function formatResetTime(resetsAt: number | null, nowSeconds: number): string {
	if (resetsAt === null) {
		return "";
	}
	const deltaSeconds = resetsAt - nowSeconds;
	if (deltaSeconds <= 0) {
		return "resets now";
	}
	const hours = Math.floor(deltaSeconds / 3600);
	const minutes = Math.floor((deltaSeconds % 3600) / 60);
	const when = hours > 0 ? `${hours}h${String(minutes).padStart(2, "0")}m` : `${minutes}m`;
	return `resets in ${when}`;
}

function windowTooltipEntry(window: RuntimeAgentBudgetWindow, nowSeconds: number): string {
	const percent = window.remainingPercent === null ? "?" : `${Math.round(window.remainingPercent)}`;
	const reset = formatResetTime(window.resetsAt, nowSeconds);
	return reset ? `${window.name}: ${percent}% · ${reset}` : `${window.name}: ${percent}%`;
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
	const nowSeconds = Math.floor(Date.now() / 1000);
	const baseTitle = provider.windows.map((w) => windowTooltipEntry(w, nowSeconds)).join(" · ");
	let staleAgeText = "";
	if (provider.staleSeconds !== null && provider.staleSeconds > STALE_THRESHOLD_SECONDS) {
		const mins = Math.floor(provider.staleSeconds / 60);
		const age = mins >= 60 ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m` : `${mins}m`;
		staleAgeText = ` (snapshot ${age} old)`;
	}
	const title = baseTitle + staleAgeText;

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
			className="inline-flex items-baseline gap-1 whitespace-nowrap"
		>
			<span data-testid={`agent-budget-pill-label-${provider.provider}`} className="text-text-secondary">
				{providerLabel(provider.provider)}
			</span>
			<span
				data-testid={`agent-budget-pill-value-${provider.provider}`}
				title={isStale ? `${title} (stale)` : title}
				className={cn("font-medium tabular-nums", agentBudgetHealthClassName(displayPercent))}
			>
				{displayPercent === null ? "?" : Math.round(displayPercent)}%{weekSuffix}
			</span>
			{isStale ? (
				<span
					data-testid={`agent-budget-pill-stale-${provider.provider}`}
					aria-hidden="true"
					className="h-1 w-1 self-center rounded-full bg-text-tertiary"
				/>
			) : null}
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
		<div data-testid="agent-budget-readout" className={cn("flex items-center gap-2 text-xs", className)}>
			{budget.providers.map((provider, index) => (
				<span key={provider.provider} className="flex items-center gap-2">
					{index > 0 ? <span aria-hidden="true" className="h-3 border-l border-border" /> : null}
					<AgentBudgetPill provider={provider} />
				</span>
			))}
		</div>
	);
}
