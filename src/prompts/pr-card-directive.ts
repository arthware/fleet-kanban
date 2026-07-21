import type { RuntimeTaskAutoReviewMode } from "../core/api-contract";

export const PR_CARD_PROMPT_DIRECTIVE =
	"You are working an auto-review PR card. Use the fleet-pr skill: commit as you go, then open one idempotent PR against the card base and leave the card in Review.\n\n";

export function prependPrCardDirective(
	prompt: string,
	autoReviewEnabled: boolean | undefined,
	autoReviewMode: RuntimeTaskAutoReviewMode | undefined,
): string {
	if (autoReviewEnabled !== true || autoReviewMode !== "pr") {
		return prompt;
	}
	return `${PR_CARD_PROMPT_DIRECTIVE}${prompt}`;
}
