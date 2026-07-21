import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runGit } from "./git-utils";

const execFileAsync = promisify(execFile);
const GH_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
// `gh` is a network call on the workspace poll path; bound it so a stalled request
// (slow network, auth prompt, rate-limit) can't hang PR capture — and, through
// captureTrackedCardPrs, the whole metadata refresh — indefinitely.
const GH_COMMAND_TIMEOUT_MS = 5_000;
const GIT_REMOTE_TIMEOUT_MS = 5_000;
const GH_PR_LIST_LIMIT = 200;
const GH_REPO_PR_LIST_ARGS = [
	"pr",
	"list",
	"--state",
	"all",
	"--limit",
	String(GH_PR_LIST_LIMIT),
	"--json",
	"headRefName,url,state,number",
] as const;

export type CardPrState = "open" | "merged" | "closed";

export interface CardPrRef {
	url: string;
	state: CardPrState;
	number: number;
}

export type GhRunner = (args: string[], cwd: string) => Promise<string>;
export type GitRemoteChecker = (cwd: string) => Promise<boolean>;

interface GhPrListItem {
	url: string;
	state: CardPrState;
	number: number;
}

interface GhRepoPrListItem extends GhPrListItem {
	headRefName: string;
}

function normalizePrState(value: unknown): CardPrState | null {
	if (typeof value !== "string") {
		return null;
	}

	const normalized = value.toLowerCase();
	if (normalized === "open" || normalized === "merged" || normalized === "closed") {
		return normalized;
	}
	return null;
}

function parseGhPrListItem(value: unknown): GhPrListItem | null {
	if (value === null || typeof value !== "object") {
		return null;
	}

	const candidate = value as { url?: unknown; state?: unknown; number?: unknown };
	const state = normalizePrState(candidate.state);
	if (typeof candidate.url !== "string" || !candidate.url.trim() || state === null) {
		return null;
	}
	if (typeof candidate.number !== "number" || !Number.isInteger(candidate.number)) {
		return null;
	}

	return {
		url: candidate.url,
		state,
		number: candidate.number,
	};
}

function parseGhRepoPrListItem(value: unknown): GhRepoPrListItem | null {
	const item = parseGhPrListItem(value);
	if (item === null || value === null || typeof value !== "object") {
		return null;
	}

	const candidate = value as { headRefName?: unknown };
	if (typeof candidate.headRefName !== "string" || !candidate.headRefName.trim()) {
		return null;
	}

	return {
		...item,
		headRefName: candidate.headRefName,
	};
}

function newestByNumber(prs: GhPrListItem[]): GhPrListItem | null {
	return prs.reduce<GhPrListItem | null>((best, candidate) => {
		if (best === null || candidate.number > best.number) {
			return candidate;
		}
		return best;
	}, null);
}

export function selectRepoCardPrsByHead(prListJson: string): Map<string, CardPrRef> {
	try {
		const parsed = JSON.parse(prListJson);
		if (!Array.isArray(parsed)) {
			return new Map();
		}

		const prItems = parsed.map(parseGhRepoPrListItem);
		if (prItems.some((item) => item === null)) {
			return new Map();
		}

		const prsByHead = new Map<string, GhRepoPrListItem[]>();
		for (const pr of prItems.filter((item): item is GhRepoPrListItem => item !== null)) {
			const headPrs = prsByHead.get(pr.headRefName) ?? [];
			headPrs.push(pr);
			prsByHead.set(pr.headRefName, headPrs);
		}

		const selectedByHead = new Map<string, CardPrRef>();
		for (const [headRefName, prs] of prsByHead) {
			const openPr = newestByNumber(prs.filter((pr) => pr.state === "open"));
			const terminalPr = newestByNumber(prs.filter((pr) => pr.state === "merged" || pr.state === "closed"));
			const selected = openPr ?? terminalPr;
			if (selected) {
				selectedByHead.set(headRefName, {
					url: selected.url,
					state: selected.state,
					number: selected.number,
				});
			}
		}
		return selectedByHead;
	} catch {
		return new Map();
	}
}

async function runGh(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("gh", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: GH_MAX_BUFFER_BYTES,
		timeout: GH_COMMAND_TIMEOUT_MS,
	});
	return stdout;
}

async function hasGitRemote(cwd: string): Promise<boolean> {
	const result = await runGit(cwd, ["remote"], { timeoutMs: GIT_REMOTE_TIMEOUT_MS });
	return result.ok && result.stdout.split(/\r?\n/u).some((remote) => remote.trim().length > 0);
}

export async function listRepoCardPrsByHead(opts: {
	cwd: string;
	run?: GhRunner;
	hasRemote?: GitRemoteChecker;
}): Promise<Map<string, CardPrRef>> {
	const hasRemote = opts.hasRemote ?? hasGitRemote;
	let remoteExists = false;
	try {
		remoteExists = await hasRemote(opts.cwd);
	} catch {
		remoteExists = false;
	}
	if (!remoteExists) {
		return new Map();
	}

	const run = opts.run ?? runGh;
	try {
		const output = await run([...GH_REPO_PR_LIST_ARGS], opts.cwd);
		return selectRepoCardPrsByHead(output);
	} catch {
		return new Map();
	}
}
