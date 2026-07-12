import type { RuntimeExternalIssue } from "./api-contract";

const LINEAR_ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;
const GITHUB_OWNER_REPO_ISSUE_PATTERN = /^[\w.-]+\/[\w.-]+#\d+$/;
const GITHUB_BARE_ISSUE_PATTERN = /^#?\d+$/;

export function parseExternalIssueRef(raw: string): RuntimeExternalIssue | null {
	const input = raw.trim();
	if (!input) {
		return null;
	}

	const linearUrl = parseLinearIssueUrl(input);
	if (linearUrl) {
		return {
			provider: "linear",
			key: linearUrl.key,
			url: input,
			raw: input,
		};
	}

	const githubUrl = parseGithubIssueUrl(input);
	if (githubUrl) {
		return {
			provider: "github",
			key: githubUrl.key,
			url: input,
			raw: input,
		};
	}

	if (LINEAR_ISSUE_KEY_PATTERN.test(input)) {
		return {
			provider: "linear",
			key: input,
			raw: input,
		};
	}

	if (GITHUB_OWNER_REPO_ISSUE_PATTERN.test(input)) {
		const [repoRef, issueNumber] = input.split("#");
		if (!repoRef || !issueNumber) {
			return null;
		}
		return {
			provider: "github",
			key: `${repoRef}#${issueNumber}`,
			url: `https://github.com/${repoRef}/issues/${issueNumber}`,
			raw: input,
		};
	}

	if (GITHUB_BARE_ISSUE_PATTERN.test(input)) {
		const issueNumber = input.replace(/^#/, "");
		return {
			provider: "github",
			key: `#${issueNumber}`,
			raw: input,
		};
	}

	return null;
}

function parseLinearIssueUrl(input: string): { key: string } | null {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.hostname !== "linear.app") {
		return null;
	}
	const segments = url.pathname.split("/").filter(Boolean);
	const issueIndex = segments.indexOf("issue");
	const key = issueIndex >= 0 ? segments[issueIndex + 1] : undefined;
	if (!key || !LINEAR_ISSUE_KEY_PATTERN.test(key)) {
		return null;
	}
	return { key };
}

function parseGithubIssueUrl(input: string): { key: string } | null {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.hostname !== "github.com") {
		return null;
	}
	const [owner, repo, type, issueNumber] = url.pathname.split("/").filter(Boolean);
	if (!owner || !repo || type !== "issues" || !issueNumber || !/^\d+$/.test(issueNumber)) {
		return null;
	}
	return {
		key: `${owner}/${repo}#${issueNumber}`,
	};
}
