import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { RuntimeBoardCard, RuntimeBoardData } from "../core/api-contract";
import { deriveTaskBranchName } from "../core/task-ref";
import { resolveTaskTitle } from "../core/task-title";
import { loadWorkspaceBoardById } from "../state/workspace-state";
import { resolveCardGhEnv } from "../terminal/agent-session-adapters";
import { runGit as runGitCommand } from "../workspace/git-utils";

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
// Push and PR creation are network calls, but on the background review path — bound
// them generously so a wedged remote can't leak a hung subprocess, yet a real push
// of a large branch is never truncated.
const COMMAND_TIMEOUT_MS = 45_000;
const FALLBACK_PR_BODY = "Automated pull request opened by the fleet board.";

/**
 * Uniform command result for the injected git/gh runners: a failed command is a
 * normal `ok: false` value, never a throw — so the orchestration below can react to
 * failure without try/catch scattered through it, and the whole helper stays a pure
 * function of its runners.
 */
export interface EnsureAutoReviewPrCommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

export type EnsureAutoReviewPrGitRunner = (cwd: string, args: string[]) => Promise<EnsureAutoReviewPrCommandResult>;
export type EnsureAutoReviewPrGhRunner = (
	cwd: string,
	args: string[],
	env: NodeJS.ProcessEnv,
) => Promise<EnsureAutoReviewPrCommandResult>;

export type EnsureAutoReviewPrOutcome = "created" | "exists" | "push_failed" | "list_failed" | "create_failed";

export interface EnsureAutoReviewPrResult {
	outcome: EnsureAutoReviewPrOutcome;
	branch: string;
	prUrl: string | null;
	detail?: string;
}

export interface EnsureAutoReviewPrInput {
	cwd: string;
	taskId: string;
	branch: string;
	baseRef: string;
	title: string;
	body: string;
	/** `GH_REPO` / `GH_PROMPT_DISABLED` so the multi-remote worktree's `gh` never goes interactive. */
	gitEnv?: NodeJS.ProcessEnv;
	runGit?: EnsureAutoReviewPrGitRunner;
	runGh?: EnsureAutoReviewPrGhRunner;
}

const defaultGitRunner: EnsureAutoReviewPrGitRunner = async (cwd, args) => {
	const result = await runGitCommand(cwd, args, { timeoutMs: COMMAND_TIMEOUT_MS });
	return { ok: result.ok, stdout: result.stdout, stderr: result.stderr };
};

const defaultGhRunner: EnsureAutoReviewPrGhRunner = async (cwd, args, env) => {
	try {
		const { stdout, stderr } = await execFileAsync("gh", args, {
			cwd,
			encoding: "utf8",
			maxBuffer: COMMAND_MAX_BUFFER_BYTES,
			timeout: COMMAND_TIMEOUT_MS,
			env: { ...process.env, ...env },
		});
		return { ok: true, stdout: String(stdout ?? "").trim(), stderr: String(stderr ?? "").trim() };
	} catch (error) {
		const candidate = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
		const stderr = String(candidate.stderr ?? "").trim() || String(candidate.message ?? "").trim();
		return { ok: false, stdout: String(candidate.stdout ?? "").trim(), stderr };
	}
};

interface ParsedPrList {
	parsed: boolean;
	hasPr: boolean;
	prUrl: string | null;
}

function parseOpenPrList(prListJson: string): ParsedPrList {
	try {
		const value = JSON.parse(prListJson);
		if (!Array.isArray(value)) {
			return { parsed: false, hasPr: false, prUrl: null };
		}
		if (value.length === 0) {
			return { parsed: true, hasPr: false, prUrl: null };
		}
		const first = value[0] as { url?: unknown };
		return { parsed: true, hasPr: true, prUrl: typeof first.url === "string" ? first.url : null };
	} catch {
		return { parsed: false, hasPr: false, prUrl: null };
	}
}

function extractCreatedPrUrl(stdout: string): string | null {
	const match = stdout.match(/https?:\/\/\S*\/pull\/\d+/);
	return match ? match[0] : null;
}

/**
 * System backstop for `autoReview=pr` cards: guarantee the card branch is pushed and
 * an open PR exists for `branch → baseRef`. Idempotent — an already-open PR (the
 * agent's own, richer one) is left untouched. Never throws into its caller; every
 * failure resolves as a structured result so the caller can log it and move on.
 *
 * Order matters: the push is attempted first (so a just-committed branch has a remote
 * to open a PR against), then the existing-PR check, then creation only when none is
 * found and the push succeeded.
 */
export async function ensureAutoReviewPr(input: EnsureAutoReviewPrInput): Promise<EnsureAutoReviewPrResult> {
	const runGit = input.runGit ?? defaultGitRunner;
	const runGh = input.runGh ?? defaultGhRunner;
	const ghEnv = input.gitEnv ?? {};
	const { cwd, branch, baseRef } = input;

	// 1. Push the card branch (idempotent; "everything up-to-date" when already pushed).
	const push = await runGit(cwd, ["push", "origin", branch]);

	// 2. Does an open PR already exist for this head → base? The agent's own PR wins.
	const listed = await runGh(
		cwd,
		["pr", "list", "--head", branch, "--base", baseRef, "--state", "open", "--json", "url,number"],
		ghEnv,
	);
	if (!listed.ok) {
		return { outcome: "list_failed", branch, prUrl: null, detail: listed.stderr };
	}
	const openPr = parseOpenPrList(listed.stdout);
	if (!openPr.parsed) {
		// Unparseable list output: do not risk a duplicate by creating blindly.
		return { outcome: "list_failed", branch, prUrl: null, detail: listed.stdout };
	}
	if (openPr.hasPr) {
		return { outcome: "exists", branch, prUrl: openPr.prUrl };
	}

	// No PR yet — but with a failed push there is no fresh remote branch to open against.
	if (!push.ok) {
		return { outcome: "push_failed", branch, prUrl: null, detail: push.stderr };
	}

	// 3. Create the backstop PR non-interactively.
	const created = await runGh(
		cwd,
		["pr", "create", "--base", baseRef, "--head", branch, "--title", input.title, "--body", input.body],
		ghEnv,
	);
	if (!created.ok) {
		return { outcome: "create_failed", branch, prUrl: null, detail: created.stderr };
	}
	return { outcome: "created", branch, prUrl: extractCreatedPrUrl(created.stdout) };
}

export interface EnsureAutoReviewPrForReviewInput {
	workspaceId: string;
	taskId: string;
	cwd: string;
	loadBoard?: (workspaceId: string) => Promise<RuntimeBoardData>;
	resolveGhEnv?: (cwd: string) => Promise<Record<string, string>>;
	runGit?: EnsureAutoReviewPrGitRunner;
	ensure?: (input: EnsureAutoReviewPrInput) => Promise<EnsureAutoReviewPrResult>;
	log?: (message: string) => void;
}

function findCard(board: RuntimeBoardData, taskId: string): RuntimeBoardCard | null {
	for (const column of board.columns) {
		for (const card of column.cards) {
			if (card.id === taskId) {
				return card;
			}
		}
	}
	return null;
}

function isAutoReviewPrCard(card: RuntimeBoardCard): boolean {
	return card.autoReviewEnabled === true && card.autoReviewMode === "pr";
}

async function resolveLastCommitBody(runGit: EnsureAutoReviewPrGitRunner, cwd: string): Promise<string> {
	const result = await runGit(cwd, ["log", "-1", "--pretty=%B"]);
	const body = result.ok ? result.stdout.trim() : "";
	return body || FALLBACK_PR_BODY;
}

/**
 * Coordinator wired at the `to_review` hook: resolve the card's PR config from the
 * board, gate to `autoReview=pr` cards only, derive the deterministic branch / title /
 * body / gh env, and delegate to {@link ensureAutoReviewPr}. Returns `null` (a clean
 * no-op) for plain cards, the home agent, or a card missing from the board. Never
 * throws — the hook fires it fire-and-forget.
 */
export async function ensureAutoReviewPrForReview(
	input: EnsureAutoReviewPrForReviewInput,
): Promise<EnsureAutoReviewPrResult | null> {
	const loadBoard = input.loadBoard ?? loadWorkspaceBoardById;
	const resolveGhEnv = input.resolveGhEnv ?? resolveCardGhEnv;
	const ensure = input.ensure ?? ensureAutoReviewPr;
	const runGit = input.runGit ?? defaultGitRunner;

	const board = await loadBoard(input.workspaceId);
	const card = findCard(board, input.taskId);
	if (!card || !isAutoReviewPrCard(card)) {
		return null;
	}

	const branch = deriveTaskBranchName({
		taskId: card.id,
		externalIssueKey: card.externalIssue?.key,
		title: card.title,
		prompt: card.prompt,
	});
	const title = resolveTaskTitle(card.title, card.prompt);
	const body = await resolveLastCommitBody(runGit, input.cwd);
	const gitEnv = await resolveGhEnv(input.cwd);

	const result = await ensure({
		cwd: input.cwd,
		taskId: card.id,
		branch,
		baseRef: card.baseRef,
		title,
		body,
		gitEnv,
	});
	input.log?.(`[auto-review-pr] task ${input.taskId} (${branch} → ${card.baseRef}): ${result.outcome}`);
	return result;
}
