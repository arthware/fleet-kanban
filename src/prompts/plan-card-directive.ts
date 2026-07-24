import { composeCardDirective } from "./compose-card-directive";

export const PLAN_CARD_PROMPT_DIRECTIVE = composeCardDirective(["fleet-plan"], { baseRef: "" });

export function prependPlanCardDirective(prompt: string, startInPlanMode: boolean | undefined): string {
	if (!startInPlanMode) {
		return prompt;
	}
	return `${PLAN_CARD_PROMPT_DIRECTIVE}${prompt}`;
}
