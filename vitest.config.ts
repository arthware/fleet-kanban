import { defineConfig } from "vitest/config";

process.env.NODE_ENV = "production";

// The suite runs one file at a time, and that is what makes the gate reliable:
// a lock held across an event-loop stall longer than its 10s staleness window
// (`src/fs/locked-file-system.ts`) gets stolen from its own holder, and
// `proper-lockfile` reports that as an `ECOMPROMISED` error thrown from a
// timer — an unhandled crash attributable to no test at all. Oversubscribing
// cores is what makes stalls that long likely.
//
// Pinning the variable is not belt-and-braces: Vitest applies
// `VITEST_MAX_WORKERS` *after* it resolves this file, so an ambient value
// silently un-caps the gate (it overrides `fileParallelism: false` too). The
// cap has to own the variable to actually hold.
process.env.VITEST_MAX_WORKERS = "1";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		// Every test gets an isolated CLINE_HOME + HOME so none can reach — or
		// delete — a real home directory (e.g. a dogfood board's worktrees). See
		// the file for the full rationale.
		setupFiles: ["./test/setup/isolated-home.ts"],
		// `packages/**` excluded: those workspaces have their own vitest
		// configs and runtime shapes (e.g. Electron) and are run explicitly by
		// CI. New workspaces under `packages/` MUST get matching install/test
		// steps in .github/workflows/test.yml or they fall out of CI coverage.
		exclude: [
			"apps/**",
			"packages/**",
			"web-ui/**",
			"third_party/**",
			"**/node_modules/**",
			"**/dist/**",
			".worktrees/**",
		],
		testTimeout: 15_000,
		maxWorkers: 1,
	},
});
