import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Base directory for all Kanban-owned runtime state — board/workspaces, task
 * worktrees, and settings/data. Defaults to `~/.cline` (upstream/standalone).
 *
 * Set the `CLINE_HOME` environment variable to relocate everything under one
 * directory so multiple Kanban instances run fully isolated (each with its own
 * board, worktrees, and settings). `fleet` points this at a project-local
 * `<project>/.fleet/cline`, keeping all runtime state with the project — like
 * `.git` — and out of the home directory.
 */
export function clineHomeDir(): string {
	const override = process.env.CLINE_HOME?.trim();
	return override ? resolve(override) : join(homedir(), ".cline");
}
