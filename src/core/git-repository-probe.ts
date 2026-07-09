import { spawnSync } from "node:child_process";

import { createGitProcessEnv } from "./git-process-env";

/**
 * Result of asking git whether a path is a working tree.
 *
 * - `yes`     — git positively confirmed a work tree.
 * - `no`      — git positively confirmed the directory is NOT a repository.
 * - `unknown` — git could not answer (binary missing, timeout/signal, or a
 *   transient non-zero exit). Callers must treat this as "keep" and never as a
 *   signal to delete durable state.
 */
export type GitRepositoryProbe = "yes" | "no" | "unknown";

// One extra attempt covers a momentary failure (e.g. a stale `.git/index.lock`
// left by an in-flight git operation) without turning the probe into a retry
// loop that could stall a reconnect.
const GIT_REPOSITORY_PROBE_RETRIES = 1;

// Bound each git invocation so a wedged git process degrades to `unknown`
// (keep) rather than hanging the caller.
const GIT_REPOSITORY_PROBE_TIMEOUT_MS = 5_000;

/**
 * Probe whether `path` is inside a git work tree, distinguishing a definitive
 * "not a repository" answer from a transient/undecidable failure.
 *
 * A definitive `no` requires git to run and explicitly report "not a git
 * repository". Anything git cannot decide — a spawn error, a timeout/signal, or
 * a transient non-zero exit that survives a bounded retry — is `unknown`, so
 * durable board state is never destroyed on a flaky signal.
 */
export function probeGitRepository(path: string): GitRepositoryProbe {
	const maxAttempts = GIT_REPOSITORY_PROBE_RETRIES + 1;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd: path,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: createGitProcessEnv(),
			timeout: GIT_REPOSITORY_PROBE_TIMEOUT_MS,
		});

		// Spawn-level failure (git binary missing) or a terminating signal
		// (including the timeout kill above) tells us nothing about the repo.
		if (result.error || result.signal) {
			return "unknown";
		}

		if (result.status === 0) {
			return result.stdout.trim() === "true" ? "yes" : "unknown";
		}

		// Non-zero exit. Only git's explicit verdict earns a `no`; every other
		// failure is treated as transient and retried, then falls through to
		// `unknown`.
		if ((result.stderr ?? "").toLowerCase().includes("not a git repository")) {
			return "no";
		}
	}

	return "unknown";
}
