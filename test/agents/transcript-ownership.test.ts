import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The cost invariant this suite protects lives in ONE module: no driver may read
 * or parse a transcript itself. Five previous freezes were each fixed in one
 * driver and reintroduced by the next, because every driver carried its own copy
 * of the whole-file `readFile` + `parseJsonlRecords` pattern. Making the shared
 * transcript source the only reader is what makes the whole class impossible.
 */
const DRIVER_SOURCES = ["claude", "codex", "gemini"].map((agentId) => ({
	agentId,
	path: resolve(process.cwd(), `src/agents/${agentId}/driver.ts`),
}));

/** A path handed back by the driver's own `locate` — the transcript, by any local name. */
const TRANSCRIPT_PATH_ARGUMENT = /\b(readFile|createReadStream|readFileSync)\(\s*(loc|location|transcript\w*)\./;

describe("transcript access ownership", () => {
	for (const { agentId, path } of DRIVER_SOURCES) {
		describe(agentId, () => {
			const source = readFileSync(path, "utf8");

			it("given the driver source, when scanned, then it does not read a located transcript file itself", () => {
				expect(TRANSCRIPT_PATH_ARGUMENT.test(source)).toBe(false);
			});

			it("given the driver source, when scanned, then it does not define its own JSONL parser", () => {
				expect(source).not.toMatch(/function parseJsonlRecords/);
			});

			it("given the driver source, when scanned, then it observes through the shared transcript source", () => {
				expect(source).toContain('from "../shared/observe"');
			});
		});
	}
});
