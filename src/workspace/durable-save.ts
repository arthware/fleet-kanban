import { runGit } from "./git-utils";

/**
 * "Is this card's work durably saved?" — the predicate that gates a card
 * becoming Done and its worktree being deleted.
 *
 * A card may only leave the board as Done when its work lives in a ref that
 * will not be garbage-collected:
 *   - commit mode → the card's commit(s) have landed on the base branch, or
 *   - pr mode     → the card's commit(s) have been merged into the base branch.
 * Anything else (uncommitted edits, un-landed commits, an unmerged PR) is work
 * that would be silently discarded if the worktree were removed — so removing
 * it must be an explicit Discard, never an automatic Done. See the incident in
 * this card's brief: a card that stalled at a `git commit` permission prompt was
 * advanced to Done and its worktree deleted, throwing away real work.
 */

export type TaskWorkDurabilityMode = "commit" | "pr";

export type TaskWorkDurabilityStatus =
	/** durable — no worktree exists, so there is nothing to lose */
	| "no_worktree"
	/** durable — clean worktree and every commit is present on the base branch */
	| "clean_and_landed"
	/** durable — clean worktree and every commit is merged into the base branch */
	| "merged"
	/** not durable — the worktree has uncommitted (or untracked) changes */
	| "uncommitted_changes"
	/** not durable — commit mode: commits exist that are not on the base branch */
	| "unlanded_commits"
	/** not durable — pr mode: commits exist that are not yet merged into the base branch */
	| "awaiting_merge"
	/** not durable (fail-safe) — the base ref or git state could not be read */
	| "indeterminate";

export interface TaskWorkDurabilityAssessment {
	durable: boolean;
	status: TaskWorkDurabilityStatus;
	detail: string;
}

/**
 * The raw git facts the classifier decides on. Kept separate from the git
 * probing so the decision itself is a pure, exhaustively unit-testable function.
 */
export interface TaskWorkDurabilitySignals {
	worktreeExists: boolean;
	/** false when git state could not be read at all (corrupt/non-git worktree) */
	gitStateReadable: boolean;
	/** true when there are no uncommitted or non-ignored untracked changes */
	workingTreeClean: boolean;
	/** true when the base ref resolved to a commit we could compare against */
	baseRefResolved: boolean;
	/** commits reachable from HEAD that are NOT present on the base branch (by patch id) */
	unlandedCommitCount: number;
	mode: TaskWorkDurabilityMode;
}

/**
 * Pure decision: given the git facts, is the card's work durably saved?
 * Fail-safe: any uncertainty (unreadable git state, unresolved base ref) is
 * treated as NOT durable so the safety net (the worktree) is retained.
 */
export function classifyTaskWorkDurability(signals: TaskWorkDurabilitySignals): TaskWorkDurabilityAssessment {
	if (!signals.worktreeExists) {
		return {
			durable: true,
			status: "no_worktree",
			detail: "No task worktree exists, so there is no work to lose.",
		};
	}

	if (!signals.gitStateReadable || !signals.baseRefResolved) {
		return {
			durable: false,
			status: "indeterminate",
			detail:
				"Could not verify the work is saved (git state or the base branch could not be read). Retaining the worktree.",
		};
	}

	if (!signals.workingTreeClean) {
		return {
			durable: false,
			status: "uncommitted_changes",
			detail: "The worktree has uncommitted changes that are not saved on the base branch.",
		};
	}

	if (signals.unlandedCommitCount > 0) {
		const plural = signals.unlandedCommitCount === 1 ? "commit" : "commits";
		if (signals.mode === "pr") {
			return {
				durable: false,
				status: "awaiting_merge",
				detail: `${signals.unlandedCommitCount} ${plural} not yet merged into the base branch (PR is not merged).`,
			};
		}
		return {
			durable: false,
			status: "unlanded_commits",
			detail: `${signals.unlandedCommitCount} ${plural} not yet landed on the base branch.`,
		};
	}

	return {
		durable: true,
		status: signals.mode === "pr" ? "merged" : "clean_and_landed",
		detail: "All work is committed and present on the base branch.",
	};
}

/**
 * Resolve the base ref to a comparable ref name, trying the ref as given and
 * then its `origin/` remote-tracking form. Returns the ref name that resolved,
 * or null if none did.
 */
async function resolveComparableBaseRef(worktreePath: string, baseRef: string): Promise<string | null> {
	const trimmed = baseRef.trim();
	if (!trimmed) {
		return null;
	}
	const candidates = trimmed.startsWith("origin/") ? [trimmed] : [trimmed, `origin/${trimmed}`];
	for (const candidate of candidates) {
		const resolved = await runGit(worktreePath, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]);
		if (resolved.ok && resolved.stdout.trim()) {
			return candidate;
		}
	}
	return null;
}

/**
 * Gather the git facts for a task worktree and classify whether its work is
 * durably saved. `worktreeExists === false` short-circuits to durable.
 */
export async function assessTaskWorkDurability(options: {
	worktreePath: string;
	worktreeExists: boolean;
	baseRef: string;
	mode: TaskWorkDurabilityMode;
}): Promise<TaskWorkDurabilityAssessment> {
	if (!options.worktreeExists) {
		return classifyTaskWorkDurability({
			worktreeExists: false,
			gitStateReadable: false,
			workingTreeClean: false,
			baseRefResolved: false,
			unlandedCommitCount: 0,
			mode: options.mode,
		});
	}

	const cwd = options.worktreePath;
	const status = await runGit(cwd, ["status", "--porcelain"]);
	const gitStateReadable = status.ok;
	const workingTreeClean = status.ok && status.stdout.trim() === "";

	const comparableBaseRef = await resolveComparableBaseRef(cwd, options.baseRef);
	let unlandedCommitCount = 0;
	if (comparableBaseRef) {
		// `git cherry` compares by patch id, so a commit that was cherry-picked
		// onto (commit mode) or merged into (pr mode) the base branch is detected
		// as present even though its sha differs. Lines starting with "+" are
		// commits on HEAD with no equivalent on the base branch.
		const cherry = await runGit(cwd, ["cherry", comparableBaseRef, "HEAD"]);
		if (cherry.ok) {
			unlandedCommitCount = cherry.stdout.split("\n").filter((line) => line.startsWith("+")).length;
		}
	}

	return classifyTaskWorkDurability({
		worktreeExists: true,
		gitStateReadable,
		workingTreeClean,
		baseRefResolved: comparableBaseRef !== null,
		unlandedCommitCount,
		mode: options.mode,
	});
}
