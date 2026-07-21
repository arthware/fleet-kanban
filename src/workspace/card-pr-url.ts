import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GH_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
// `gh` is a network call on the workspace poll path; bound it so a stalled request
// (slow network, auth prompt, rate-limit) can't hang PR capture — and, through
// captureTrackedCardPrs, the whole metadata refresh — indefinitely.
const GH_COMMAND_TIMEOUT_MS = 5_000;
const GH_PR_LIST_ARGS_PREFIX = ["pr", "list", "--head"] as const;
const GH_PR_LIST_ARGS_SUFFIX = ["--state", "all", "--json", "url,state,number,title"] as const;

export type CardPrState = "open" | "merged" | "closed";

export interface CardPrRef {
	url: string;
	state: CardPrState;
	number: number;
}

export type GhRunner = (args: string[], cwd: string) => Promise<string>;

interface GhPrListItem {
	url: string;
	state: CardPrState;
	number: number;
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

function newestByNumber(prs: GhPrListItem[]): GhPrListItem | null {
	return prs.reduce<GhPrListItem | null>((best, candidate) => {
		if (best === null || candidate.number > best.number) {
			return candidate;
		}
		return best;
	}, null);
}

export function selectCardPrUrl(prListJson: string): CardPrRef | null {
	try {
		const parsed = JSON.parse(prListJson);
		if (!Array.isArray(parsed)) {
			return null;
		}

		const prItems = parsed.map(parseGhPrListItem);
		if (prItems.some((item) => item === null)) {
			return null;
		}

		const validPrs = prItems.filter((item): item is GhPrListItem => item !== null);
		const openPr = newestByNumber(validPrs.filter((pr) => pr.state === "open"));
		const terminalPr = newestByNumber(validPrs.filter((pr) => pr.state === "merged" || pr.state === "closed"));
		const selected = openPr ?? terminalPr;
		if (selected === null) {
			return null;
		}

		return {
			url: selected.url,
			state: selected.state,
			number: selected.number,
		};
	} catch {
		return null;
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

export async function resolveCardPrUrl(opts: {
	branch: string;
	cwd: string;
	run?: GhRunner;
}): Promise<CardPrRef | null> {
	const run = opts.run ?? runGh;
	try {
		const output = await run([...GH_PR_LIST_ARGS_PREFIX, opts.branch, ...GH_PR_LIST_ARGS_SUFFIX], opts.cwd);
		return selectCardPrUrl(output);
	} catch {
		return null;
	}
}
