import { isHomeAgentSessionId } from "../core/home-agent-session";
import { composeCardDirective } from "./compose-card-directive";

export const IMPLEMENT_CARD_PROMPT_DIRECTIVE = composeCardDirective(["fleet-implement"], { baseRef: "" });

export function prependImplementCardDirective(
	prompt: string,
	taskId: string,
	startInPlanMode: boolean | undefined,
): string {
	if (startInPlanMode === true || isHomeAgentSessionId(taskId)) {
		return prompt;
	}
	return `${IMPLEMENT_CARD_PROMPT_DIRECTIVE}${prompt}`;
}
