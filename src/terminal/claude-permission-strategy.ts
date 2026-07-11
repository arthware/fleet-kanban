/**
 * Capability-tiered permission strategy for autonomous Claude Code launches.
 *
 * Autonomous cards must run unattended (no permission prompts). Empirically, on the
 * direct Anthropic API:
 * - Capable models (Opus, Sonnet) glide through `--permission-mode auto` — auto mode
 *   auto-accepts edits and bash steps, so they never stall. This is upstream intent
 *   from cline/kanban#532 and must be preserved.
 * - Weaker/cheaper models (Haiku, and any mini/fast/lite tier) still hit a permission
 *   prompt on bash/git steps under auto mode and stall (surfacing as `needs_input`).
 *   They need a real bypass (`--dangerously-skip-permissions`) to run unattended —
 *   but only behind the destructive-command guard hook (the safety floor).
 *
 * On a cloud-provider backend (Bedrock / Vertex / Foundry), Claude Code honours
 * `CLAUDE_CODE_ENABLE_AUTO_MODE=1`, which makes auto mode a reliable unattended bypass
 * for every tier. There we keep auto mode regardless of model and never reach for
 * skip-permissions.
 */

export type ClaudePermissionStrategy = "auto" | "bypass-guarded";

/** Provider toggle env vars that switch Claude Code off the direct Anthropic API. */
const CLOUD_PROVIDER_TOGGLE_VARS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];

function isTruthyEnv(value: string | undefined): boolean {
	if (!value) {
		return false;
	}
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

/**
 * True when Claude Code is pointed at a cloud-provider backend (Bedrock / Vertex /
 * Foundry) rather than the direct Anthropic API. On those backends auto mode is a
 * reliable unattended bypass via `CLAUDE_CODE_ENABLE_AUTO_MODE`.
 */
export function isClaudeCloudProviderBackend(env: NodeJS.ProcessEnv = process.env): boolean {
	return CLOUD_PROVIDER_TOGGLE_VARS.some((name) => isTruthyEnv(env[name]));
}

/**
 * Whether a model is capable enough to run unattended under `--permission-mode auto`
 * on the direct Anthropic API.
 *
 * Recognised capable tiers: Opus and Sonnet. Sonnet is deliberately classified as
 * capable — on the Anthropic API it clears auto mode's bash/git steps without stalling
 * the same way Opus does, and it's the default agent model, so treating it as weak
 * would needlessly widen the skip-permissions surface.
 *
 * An unset model means the workspace default (a capable model), so it stays on auto.
 * Everything else — Haiku, any mini/fast/lite/cheap tier, or an unrecognised slug —
 * defaults to the guarded bypass so the card still runs unattended AND stays behind
 * the destructive-command guard. Unattended-safety wins on ambiguity; the guard makes
 * that safe.
 */
export function isAutoModeCapableModel(agentModel: string | undefined): boolean {
	const model = agentModel?.trim().toLowerCase();
	if (!model) {
		return true;
	}
	if (model.includes("opus") || model.includes("sonnet")) {
		return true;
	}
	return false;
}

export interface ResolveClaudePermissionStrategyInput {
	agentModel: string | undefined;
	/** Whether Claude Code targets a cloud-provider backend (auto mode reliable there). */
	cloudProviderBackend: boolean;
}

/**
 * Resolve the permission strategy for an autonomous Claude launch.
 *
 * - Cloud-provider backend → `auto` (auto mode is a reliable bypass there for all tiers).
 * - Direct Anthropic API + capable model → `auto` (preserve #532; no prompts).
 * - Direct Anthropic API + weak/unknown model → `bypass-guarded` (real bypass behind
 *   the destructive-command guard hook).
 */
export function resolveClaudePermissionStrategy(input: ResolveClaudePermissionStrategyInput): ClaudePermissionStrategy {
	if (input.cloudProviderBackend) {
		return "auto";
	}
	return isAutoModeCapableModel(input.agentModel) ? "auto" : "bypass-guarded";
}
