import { describe, expect, it } from "vitest";
import { createHomeAgentSessionId } from "../../../src/core/home-agent-session";
import {
	IMPLEMENT_CARD_PROMPT_DIRECTIVE,
	prependImplementCardDirective,
} from "../../../src/prompts/implement-card-directive";

describe("prependImplementCardDirective", () => {
	const cardTaskId = "03bc4";

	it("given a build card (a task card, not plan mode), when the prompt is built, then the fleet-implement directive is prepended", () => {
		// given
		const prompt = "Do the thing.";
		// when
		const result = prependImplementCardDirective(prompt, cardTaskId, false);
		// then
		expect(result).toBe(`${IMPLEMENT_CARD_PROMPT_DIRECTIVE}${prompt}`);
	});

	it("given a build card with startInPlanMode undefined, when the prompt is built, then it is still treated as a build card", () => {
		// given
		const prompt = "Do the thing.";
		// when
		const result = prependImplementCardDirective(prompt, cardTaskId, undefined);
		// then
		expect(result).toBe(`${IMPLEMENT_CARD_PROMPT_DIRECTIVE}${prompt}`);
	});

	it("given a plan card, when the prompt is built, then it is left unchanged (plan cards use fleet-plan)", () => {
		// given
		const prompt = "Design the thing.";
		// when
		const result = prependImplementCardDirective(prompt, cardTaskId, true);
		// then
		expect(result).toBe(prompt);
	});

	it("given the home/architect agent, when the prompt is built, then it is left unchanged (not a card)", () => {
		// given
		const homeAgentId = createHomeAgentSessionId("fleet-kanban", "claude");
		const prompt = "Orchestrate.";
		// when
		const result = prependImplementCardDirective(prompt, homeAgentId, false);
		// then
		expect(result).toBe(prompt);
	});
});
