import type { RuntimeTaskAutoReviewMode } from "../core/api-contract";

// Names the card's resolved base-ref literally so the agent never falls back to `gh pr create`'s
// default (the repo's default branch). That default is `main`, which is often behind the card's
// actual base-ref (e.g. `production-line`), so an unqualified PR shows already-landed commits as
// "unrelated" and can't be cleanly merged. The base-ref is known data at session start; stating it
// here is the reliable channel (every agent gets it, unlike a skill that may not load).
export function buildPrCardPromptDirective(baseRef: string): string {
	return `You are working an auto-review PR card. Use the fleet-pr skill: commit as you go, then open one idempotent PR against this card's base branch \`${baseRef}\` (\`gh pr create --base ${baseRef}\`) and leave the card in Review. Never open the PR against the repository's default branch.\n\n`;
}

export function prependPrCardDirective(
	prompt: string,
	autoReviewEnabled: boolean | undefined,
	autoReviewMode: RuntimeTaskAutoReviewMode | undefined,
	baseRef: string,
): string {
	if (autoReviewEnabled !== true || autoReviewMode !== "pr") {
		return prompt;
	}
	return `${buildPrCardPromptDirective(baseRef)}${prompt}`;
}
