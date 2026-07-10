#!/usr/bin/env node
// Killswitch-safe throwaway Kanban board for manual verification.
//
// Boots the built server on a RANDOM port (never 3500/3484) under a throwaway
// CLINE_HOME temp dir, prints the URL, and cleans everything up on Ctrl-C. Use
// this to verify a board change instead of ever pointing at the live board.
//
//   npm run build && npm run kanban:scratch
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(process.cwd(), "dist/cli.js");
if (!existsSync(cli)) {
	console.error(`dist/cli.js not found — run 'npm run build' first (looked in ${cli}).`);
	process.exit(1);
}

const port = 3600 + Math.floor(Math.random() * 300); // random ephemeral port; never 3500/3484
const home = mkdtempSync(join(tmpdir(), "kanban-scratch-"));

const child = spawn(process.execPath, [cli, "--port", String(port), "--no-open", "--skip-shutdown-cleanup"], {
	stdio: "inherit",
	env: { ...process.env, CLINE_HOME: home, KANBAN_RUNTIME_PORT: String(port) },
});

console.log(`\n▸ scratch kanban → http://127.0.0.1:${port}   (throwaway CLINE_HOME=${home})`);
console.log("  Ctrl-C to stop and remove the temp home.\n");

let cleaned = false;
function cleanup() {
	if (cleaned) {
		return;
	}
	cleaned = true;
	try {
		child.kill("SIGTERM");
	} catch {}
	rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

process.on("SIGINT", () => {
	cleanup();
	process.exit(0);
});
process.on("SIGTERM", () => {
	cleanup();
	process.exit(0);
});
child.on("exit", (code) => {
	cleanup();
	process.exit(code ?? 0);
});
