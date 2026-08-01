import type { Command } from "commander";
import { formatTable, getAgentBudget, getAggregatedBudget } from "../server/agent-budget";

export function registerBudgetCommand(program: Command): void {
	program
		.command("budget")
		.description("Remaining session/window budget for local coding agents.")
		.option("--json", "Machine-readable output.")
		.option("--no-claude", "Disable Claude budget.")
		.option("--no-codex", "Disable Codex budget.")
		.option("--no-cursor", "Disable Cursor budget.")
		.option("--no-color", "Disable color output.")
		.option("--banner", "Format output as a banner for task list.")
		.option("--cached", "Use the short-TTL in-memory/server budget if available.")
		.action(async (options) => {
			let report: any;
			if (options.cached) {
				const response = await getAgentBudget();
				report = {
					generatedAt: response.generatedAt ?? Math.floor(Date.now() / 1000),
					providers: response.providers.map((p) => ({
						provider: p.provider,
						plan: p.plan,
						staleSeconds: p.staleSeconds,
						worstRemainingPercent: p.worstRemainingPercent,
						windows: p.windows.map((w) => ({
							name: w.name,
							remainingPercent: w.remainingPercent,
							resetsAt: w.resetsAt,
						})),
					})),
				};
			} else {
				report = await getAggregatedBudget();
			}

			// Apply filters
			let providers = report.providers;
			if (options.claude === false) {
				providers = providers.filter((p: any) => p.provider !== "claude");
			}
			if (options.codex === false) {
				providers = providers.filter((p: any) => p.provider !== "codex");
			}
			if (options.cursor === false) {
				providers = providers.filter((p: any) => p.provider !== "cursor");
			}

			if (options.json) {
				process.stdout.write(
					`${JSON.stringify(
						{
							generated_at: report.generatedAt,
							providers,
						},
						null,
						2,
					)}\n`,
				);
				return;
			}

			const isAtty = process.stdout.isTTY;
			const useColor = isAtty && options.color !== false;

			let output = formatTable(providers, report.generatedAt, useColor);

			if (options.banner) {
				const D = useColor ? "\x1b[2m" : "";
				const R = useColor ? "\x1b[0m" : "";
				const indent = "  ";
				const lines = output
					.split("\n")
					.map((line) => indent + line)
					.join("\n");
				output = `${D}budget${R}  ${D}(remaining per window — steer heavy dispatch on the lowest)${R}\n${lines}\n`;
			}

			process.stdout.write(`${output}\n`);
		});
}
