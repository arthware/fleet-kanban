import type { BoardCard, TaskAutoReviewMode } from "@/types";
import { resolveTaskAutoReviewMode } from "@/types";

export type CardKind = "plan" | "build";

export type BuildCardCompletionPolicy = "manual" | "auto-commit" | "auto-pr";
export type PlanCardCompletionPolicy = "unknown";

export type CardCompletionPolicy =
	| {
			kind: "build";
			policy: BuildCardCompletionPolicy;
	  }
	| {
			kind: "plan";
			policy: PlanCardCompletionPolicy;
	  };

type CardKindFields = Pick<BoardCard, "startInPlanMode">;
type CardCompletionPolicyFields = Pick<BoardCard, "startInPlanMode" | "autoReviewEnabled" | "autoReviewMode">;

export function cardKind(card: CardKindFields): CardKind {
	return card.startInPlanMode === true ? "plan" : "build";
}

function buildCompletionPolicyFromAutoReviewMode(
	mode: TaskAutoReviewMode | null | undefined,
): BuildCardCompletionPolicy {
	const resolvedMode = resolveTaskAutoReviewMode(mode);
	return resolvedMode === "pr" ? "auto-pr" : "auto-commit";
}

export function cardCompletionPolicy(card: CardCompletionPolicyFields): CardCompletionPolicy {
	const kind = cardKind(card);
	if (kind === "plan") {
		return { kind, policy: "unknown" };
	}
	if (card.autoReviewEnabled === true) {
		return { kind, policy: buildCompletionPolicyFromAutoReviewMode(card.autoReviewMode) };
	}
	return { kind, policy: "manual" };
}

export function getCardCompletionPolicyBadgeLabel(policy: CardCompletionPolicy): string | null {
	if (policy.kind === "plan") {
		return null;
	}
	if (policy.policy === "auto-pr") {
		return "Auto-PR";
	}
	if (policy.policy === "auto-commit") {
		return "Auto-commit";
	}
	return null;
}

export function getTaskCompletionPolicyBadgeLabel(card: CardCompletionPolicyFields): string | null {
	return getCardCompletionPolicyBadgeLabel(cardCompletionPolicy(card));
}
