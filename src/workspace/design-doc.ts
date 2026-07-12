import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeDesignDocResponse } from "../core/api-contract";

const UNSAFE_FILENAME_CHARS_PATTERN = /[^A-Za-z0-9._-]+/g;
const LEADING_TRAILING_DASHES_PATTERN = /^-+|-+$/g;

export function sanitizeDesignDocRef(value: string): string {
	return value.trim().replace(UNSAFE_FILENAME_CHARS_PATTERN, "-").replace(LEADING_TRAILING_DASHES_PATTERN, "");
}

export function resolveDesignDocRefCandidates(input: { taskId: string; externalIssueKey?: string }): string[] {
	const candidates: string[] = [];
	const externalIssueRef = input.externalIssueKey ? sanitizeDesignDocRef(input.externalIssueKey) : "";
	if (externalIssueRef) {
		candidates.push(externalIssueRef);
	}
	const taskIdRef = sanitizeDesignDocRef(input.taskId);
	if (taskIdRef && !candidates.includes(taskIdRef)) {
		candidates.push(taskIdRef);
	}
	return candidates;
}

export async function readTaskDesignDoc(input: {
	projectRoot: string;
	taskId: string;
	externalIssueKey?: string;
}): Promise<RuntimeDesignDocResponse> {
	const designDir = join(input.projectRoot, "docs", "design");
	let entries: string[];
	try {
		entries = await readdir(designDir);
	} catch {
		return { exists: false };
	}

	for (const ref of resolveDesignDocRefCandidates(input)) {
		const prefix = `${ref}-`;
		const match = entries
			.filter((entry) => entry.startsWith(prefix) && entry.endsWith(".md"))
			.sort((left, right) => left.localeCompare(right))[0];
		if (!match) {
			continue;
		}
		const path = join(designDir, match);
		try {
			const content = await readFile(path, "utf8");
			return { exists: true, path, content };
		} catch {
			return { exists: false };
		}
	}
	return { exists: false };
}
