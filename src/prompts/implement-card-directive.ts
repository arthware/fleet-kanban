import { isHomeAgentSessionId } from "../core/home-agent-session";

// Name the skill and the card context only — the skill's own frontmatter/body is the single source
// of truth for how to work a build card. Don't restate its internals here (they would drift). The
// commit-authorization sentence is the exception: AGENTS.md's "never commit unless user asks" is
// written for human sessions, and a literal-minded agent (observed with Gemini) applies it to card
// work too and halts asking permission to commit. State the authorization explicitly here since this
// directive reaches every agent, unlike a skill that may not load.
export const IMPLEMENT_CARD_PROMPT_DIRECTIVE =
	"You are working a build card. Use the fleet-implement skill. The card is your authorization to commit — commit as you go and never pause to ask for confirmation; the repo's 'never commit unless asked' guardrail is written for human sessions and is satisfied by this card.\n\n";

// A build card is any real task card that is not a plan card. The home/architect agent is not a
// card at all, so it never gets this directive. (Auto-PR is orthogonal — a build card can also be a
// PR card, and the fleet-implement / fleet-pr skills compose.)
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
