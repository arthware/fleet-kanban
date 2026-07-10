import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * Safety floor for every server test: never resolve to a real home directory.
 *
 * `clineHomeDir()` prefers `$CLINE_HOME` over `$HOME` (see
 * `src/config/cline-home.ts`), so a test that isolates only `$HOME` still
 * resolves to whatever `CLINE_HOME` the launching shell exported. In a dogfood
 * setup that is a real board home whose `worktrees/` holds the very worktree the
 * test is running in — so a test that cleans `$CLINE_HOME/worktrees` deletes its
 * own worktree (tracked files, `node_modules`, and the `.git` pointer). This has
 * happened.
 *
 * The fix is to strip any inherited `CLINE_HOME` and point `HOME` at a throwaway
 * directory. `clineHomeDir()` then falls back to `homedir()/.cline`, and
 * `os.homedir()` follows `$HOME` on POSIX — so the whole suite resolves under a
 * temp home by construction, regardless of the ambient environment. This also
 * restores the assumption every existing test is written against (that isolating
 * `$HOME` is enough); tests that set their own `CLINE_HOME`/`HOME` still win.
 */
const home = mkdtempSync(join(tmpdir(), "kanban-test-home-"));
mkdirSync(home, { recursive: true });
process.env.HOME = home;
delete process.env.CLINE_HOME;

afterAll(() => {
	rmSync(home, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 });
});
