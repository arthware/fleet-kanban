import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GhRunner } from "./card-pr-url";

const execFileAsync = promisify(execFile);
const MAX_BUFFER_BYTES = 1024 * 1024;
const GITHUB_REPO_REF_PATTERN = /^[\w.-]+\/[\w.-]+$/;

async function runGh(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("gh", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: MAX_BUFFER_BYTES,
	});
	return stdout;
}

async function runGit(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: MAX_BUFFER_BYTES,
	});
	return stdout;
}

function normalizeNameWithOwner(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim();
	return GITHUB_REPO_REF_PATTERN.test(normalized) ? normalized : null;
}

export function parseGhRepoViewNameWithOwner(output: string): string | null {
	try {
		const parsed = JSON.parse(output) as { nameWithOwner?: unknown };
		return normalizeNameWithOwner(parsed.nameWithOwner);
	} catch {
		return null;
	}
}

export function parseGithubRemoteNameWithOwner(remoteUrl: string): string | null {
	const input = remoteUrl.trim();
	if (!input) {
		return null;
	}
	const sshMatch = /^git@github\.com:([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(input);
	if (sshMatch?.[1]) {
		return normalizeNameWithOwner(sshMatch[1]);
	}
	try {
		const url = new URL(input);
		if (url.hostname !== "github.com") {
			return null;
		}
		const [owner, repoWithSuffix] = url.pathname.split("/").filter(Boolean);
		if (!owner || !repoWithSuffix) {
			return null;
		}
		const repo = repoWithSuffix.replace(/\.git$/, "");
		return normalizeNameWithOwner(`${owner}/${repo}`);
	} catch {
		return null;
	}
}

export async function resolveRepoNameWithOwner(cwd: string, run?: GhRunner): Promise<string | null> {
	const gh = run ?? runGh;
	try {
		const output = await gh(["repo", "view", "--json", "nameWithOwner"], cwd);
		const nameWithOwner = parseGhRepoViewNameWithOwner(output);
		if (nameWithOwner) {
			return nameWithOwner;
		}
	} catch {
		// Fall back to origin below.
	}

	try {
		const origin = await runGit(["remote", "get-url", "origin"], cwd);
		return parseGithubRemoteNameWithOwner(origin);
	} catch {
		return null;
	}
}
