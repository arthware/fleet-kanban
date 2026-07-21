import { resolveTaskTitle } from "./task-title";

const TASK_REF_UNSAFE_CHARS_PATTERN = /[^a-z0-9]+/g;
const LEGACY_DESIGN_DOC_REF_UNSAFE_CHARS_PATTERN = /[^A-Za-z0-9._-]+/g;
const LEADING_TRAILING_DASHES_PATTERN = /^-+|-+$/g;
export const TASK_BRANCH_NAME_MAX_CHARS = 60;

export function sanitizeDesignDocRef(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(TASK_REF_UNSAFE_CHARS_PATTERN, "-")
		.replace(LEADING_TRAILING_DASHES_PATTERN, "");
}

export function resolveTaskRef(input: { taskId: string; externalIssueKey?: string }): string {
	const externalIssueRef = input.externalIssueKey ? sanitizeDesignDocRef(input.externalIssueKey) : "";
	if (externalIssueRef) {
		return externalIssueRef;
	}
	return sanitizeDesignDocRef(input.taskId) || "task";
}

function sanitizeLegacyDesignDocRef(value: string): string {
	return value
		.trim()
		.replace(LEGACY_DESIGN_DOC_REF_UNSAFE_CHARS_PATTERN, "-")
		.replace(LEADING_TRAILING_DASHES_PATTERN, "");
}

function pushUnique(candidates: string[], value: string): void {
	if (value && !candidates.includes(value)) {
		candidates.push(value);
	}
}

export function resolveDesignDocRefCandidates(input: { taskId: string; externalIssueKey?: string }): string[] {
	const candidates: string[] = [];
	const externalIssueRef = input.externalIssueKey ? sanitizeDesignDocRef(input.externalIssueKey) : "";
	if (externalIssueRef) {
		candidates.push(externalIssueRef);
	}
	const taskIdRef = sanitizeDesignDocRef(input.taskId);
	pushUnique(candidates, taskIdRef);

	if (input.externalIssueKey) {
		pushUnique(candidates, sanitizeLegacyDesignDocRef(input.externalIssueKey));
	}
	pushUnique(candidates, sanitizeLegacyDesignDocRef(input.taskId));
	return candidates;
}

export function slugifyTaskTitle(value: string): string {
	return sanitizeDesignDocRef(value);
}

function capTaskBranchName(ref: string, slug: string): string {
	const candidate = slug ? `${ref}-${slug}` : ref;
	if (candidate.length <= TASK_BRANCH_NAME_MAX_CHARS) {
		return candidate;
	}
	const sliced = candidate.slice(0, TASK_BRANCH_NAME_MAX_CHARS).replace(LEADING_TRAILING_DASHES_PATTERN, "");
	const boundary = sliced.lastIndexOf("-");
	if (boundary > ref.length) {
		return sliced.slice(0, boundary).replace(LEADING_TRAILING_DASHES_PATTERN, "");
	}
	return sliced || ref;
}

export function isValidTaskBranchName(value: string): boolean {
	return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value);
}

export function deriveTaskBranchName(input: {
	taskId: string;
	externalIssueKey?: string;
	title?: string | null;
	prompt: string;
}): string {
	const ref = resolveTaskRef(input);
	const slug = slugifyTaskTitle(resolveTaskTitle(input.title, input.prompt));
	const branchName = capTaskBranchName(ref, slug);
	return isValidTaskBranchName(branchName) ? branchName : ref;
}
