export const PLAN_CARD_PROMPT_DIRECTIVE =
	"You are working a plan card. Use the fleet-plan skill: investigate and write a design doc; do not implement.\n\n";

export function prependPlanCardDirective(prompt: string, startInPlanMode: boolean | undefined): string {
	if (!startInPlanMode) {
		return prompt;
	}
	return `${PLAN_CARD_PROMPT_DIRECTIVE}${prompt}`;
}
