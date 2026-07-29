export type TaskPromptComposerCompletionKind = "mention" | "slash";

export interface ActiveTaskPromptComposerToken {
	kind: TaskPromptComposerCompletionKind;
	start: number;
	end: number;
	query: string;
}

function isTokenBoundaryCharacter(value: string | undefined): boolean {
	return !value || /\s/.test(value);
}

export function detectActiveTaskPromptComposerToken(
	value: string,
	cursorIndex: number,
): ActiveTaskPromptComposerToken | null {
	if (cursorIndex < 0 || cursorIndex > value.length) {
		return null;
	}
	const head = value.slice(0, cursorIndex);
	let tokenStart = head.length;
	while (tokenStart > 0) {
		const previousCharacter = head[tokenStart - 1];
		if (previousCharacter && /\s/.test(previousCharacter)) {
			break;
		}
		tokenStart -= 1;
	}

	const token = head.slice(tokenStart);
	if (token.startsWith("@")) {
		const markerIndex = tokenStart;
		if (!isTokenBoundaryCharacter(value[markerIndex - 1])) {
			return null;
		}
		if (!/^[^\s@]*$/.test(token.slice(1))) {
			return null;
		}
		return {
			kind: "mention",
			start: tokenStart,
			end: cursorIndex,
			query: token.slice(1),
		};
	}

	if (token.startsWith("/")) {
		const markerIndex = tokenStart;
		if (!isTokenBoundaryCharacter(value[markerIndex - 1])) {
			return null;
		}
		if (!/^[^\s/]*$/.test(token.slice(1))) {
			return null;
		}
		return {
			kind: "slash",
			start: tokenStart,
			end: cursorIndex,
			query: token.slice(1),
		};
	}

	return null;
}

export function buildMentionInsertText(filePath: string): string {
	const normalizedPath = filePath.startsWith("/") ? filePath : `/${filePath}`;
	return normalizedPath.includes(" ") ? `@"${normalizedPath}"` : `@${normalizedPath}`;
}

export function applyTaskPromptComposerCompletion(
	value: string,
	token: ActiveTaskPromptComposerToken,
	replacement: string,
): { value: string; cursor: number } {
	const before = value.slice(0, token.start);
	const after = value.slice(token.end);
	const spacer = after.length === 0 || !/^\s/.test(after) ? " " : "";
	const nextValue = `${before}${replacement}${spacer}${after}`;
	return {
		value: nextValue,
		cursor: before.length + replacement.length + spacer.length,
	};
}
