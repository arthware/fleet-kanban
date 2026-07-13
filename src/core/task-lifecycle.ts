export type BoardLifecycleColumnId = "backlog" | "in_progress" | "review" | "done" | "trash";

export interface BoardLifecycleTransition {
	column: BoardLifecycleColumnId;
	at: number;
}

export interface BoardLifecycleCard {
	createdAt: number;
	updatedAt: number;
	transitions?: BoardLifecycleTransition[];
}

export interface BoardLifecycleColumn<Card extends BoardLifecycleCard = BoardLifecycleCard> {
	id: BoardLifecycleColumnId;
	cards: Card[];
}

export interface BoardLifecycleData<Card extends BoardLifecycleCard = BoardLifecycleCard> {
	columns: Array<BoardLifecycleColumn<Card>>;
}

export function getTaskStartedAt(card: BoardLifecycleCard): number | undefined {
	return card.transitions?.find((transition) => transition.column === "in_progress")?.at;
}

export function getTaskCompletedAt(card: BoardLifecycleCard): number | undefined {
	if (!card.transitions) {
		return undefined;
	}
	for (let index = card.transitions.length - 1; index >= 0; index -= 1) {
		const transition = card.transitions[index];
		if (transition?.column === "done") {
			return transition.at;
		}
	}
	return undefined;
}

function backfillCardTransitions<Card extends BoardLifecycleCard>(
	card: Card,
	currentColumnId: BoardLifecycleColumnId,
): Card {
	if (card.transitions && card.transitions.length > 0) {
		return card;
	}
	const transitions: BoardLifecycleTransition[] = [{ column: "backlog", at: card.createdAt }];
	if (currentColumnId !== "backlog") {
		transitions.push({ column: currentColumnId, at: card.updatedAt });
	}
	return {
		...card,
		transitions,
	};
}

function getDoneSortTimestamp(card: BoardLifecycleCard): number {
	return getTaskCompletedAt(card) ?? card.updatedAt;
}

function sortDoneCards<Card extends BoardLifecycleCard>(cards: Card[]): Card[] {
	return cards
		.map((card, index) => ({ card, index }))
		.sort((left, right) => {
			const timeDelta = getDoneSortTimestamp(right.card) - getDoneSortTimestamp(left.card);
			return timeDelta !== 0 ? timeDelta : left.index - right.index;
		})
		.map(({ card }) => card);
}

export function sortCardsForColumn<Card extends BoardLifecycleCard>(
	columnId: BoardLifecycleColumnId,
	cards: Card[],
): Card[] {
	return columnId === "done" ? sortDoneCards(cards) : cards;
}

export function normalizeBoardTransitionsAndOrdering<Board extends BoardLifecycleData>(board: Board): Board {
	return {
		...board,
		columns: board.columns.map((column) => {
			const cardsWithTransitions = column.cards.map((card) => backfillCardTransitions(card, column.id));
			const cards = sortCardsForColumn(column.id, cardsWithTransitions);
			return cards === column.cards ? column : { ...column, cards };
		}),
	};
}
