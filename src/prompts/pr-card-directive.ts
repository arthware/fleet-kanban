import type { RuntimeTaskAutoReviewMode } from "../core/api-contract";
import { composeCardDirective } from "./compose-card-directive";

export function buildPrCardPromptDirective(baseRef: string): string {
	return composeCardDirective(["fleet-pr"], { baseRef });
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
