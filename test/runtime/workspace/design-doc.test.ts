import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	readTaskDesignDoc,
	resolveDesignDocRefCandidates,
	sanitizeDesignDocRef,
} from "../../../src/workspace/design-doc";

let tempDirs: string[] = [];

async function makeProjectRoot(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "fleet-kanban-design-doc-"));
	tempDirs.push(dir);
	return dir;
}

describe("design doc resolution", () => {
	afterEach(async () => {
		await Promise.all(tempDirs.map(async (dir) => await rm(dir, { recursive: true, force: true })));
		tempDirs = [];
	});

	it.each([
		["ENG-123", "ENG-123"],
		["owner/repo#12", "owner-repo-12"],
		["#12", "12"],
	])("sanitizes %s as %s", (input, expected) => {
		expect(sanitizeDesignDocRef(input)).toBe(expected);
	});

	it("prefers the sanitized external issue key before falling back to task id", async () => {
		const projectRoot = await makeProjectRoot();
		const designDir = join(projectRoot, "docs", "design");
		await mkdir(designDir, { recursive: true });
		await writeFile(join(designDir, "05506-fallback.md"), "fallback doc");
		await writeFile(join(designDir, "owner-repo-12-api.md"), "issue doc");

		const result = await readTaskDesignDoc({
			projectRoot,
			taskId: "05506",
			externalIssueKey: "owner/repo#12",
		});

		expect(resolveDesignDocRefCandidates({ taskId: "05506", externalIssueKey: "owner/repo#12" })).toEqual([
			"owner-repo-12",
			"05506",
		]);
		expect(result.exists).toBe(true);
		expect(result.path).toBe(join(designDir, "owner-repo-12-api.md"));
		expect(result.content).toBe("issue doc");
	});

	it("falls back to task id when no external issue doc matches", async () => {
		const projectRoot = await makeProjectRoot();
		const designDir = join(projectRoot, "docs", "design");
		await mkdir(designDir, { recursive: true });
		await writeFile(join(designDir, "05506-fallback.md"), "fallback doc");

		const result = await readTaskDesignDoc({
			projectRoot,
			taskId: "05506",
			externalIssueKey: "ENG-123",
		});

		expect(result).toEqual({
			exists: true,
			path: join(designDir, "05506-fallback.md"),
			content: "fallback doc",
		});
	});

	it("returns exists false for a missing design directory or no match", async () => {
		const projectRoot = await makeProjectRoot();
		await expect(readTaskDesignDoc({ projectRoot, taskId: "05506" })).resolves.toEqual({ exists: false });

		await mkdir(join(projectRoot, "docs", "design"), { recursive: true });
		await expect(readTaskDesignDoc({ projectRoot, taskId: "05506" })).resolves.toEqual({ exists: false });
	});
});
