import type { BoardCard, BoardColumnId } from "../types/board";

export function resolvePhaseLabelForLane(card: BoardCard, lane: BoardColumnId): string | undefined {
	if (lane === "backlog" || lane === "trash") {
		return undefined;
	}

	const type = card.cardType ?? "build";

	if (type === "plan") {
		if (lane === "in_progress") {
			return "design";
		}
		if (lane === "review" || lane === "done") {
			return "verify";
		}
	} else if (type === "build") {
		if (lane === "in_progress") {
			if (card.autoReviewEnabled && card.autoReviewMode === "pr") {
				return "build·ship";
			}
			return "build";
		}
		if (lane === "review" || lane === "done") {
			return "verify";
		}
	}

	return undefined;
}
