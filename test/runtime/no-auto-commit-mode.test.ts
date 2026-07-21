import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOTS = ["src", "web-ui/src"] as const;
const AUTO_REVIEW_COMMIT_BRANCH_PATTERN =
	/autoReviewMode\s*(?:={2,3}|!==?)\s*["']commit["']|["']commit["']\s*(?:={2,3}|!==?)\s*autoReviewMode/gu;

function collectSourceFiles(root: string): string[] {
	const entries = readdirSync(root);
	const files: string[] = [];

	for (const entry of entries) {
		const path = join(root, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			files.push(...collectSourceFiles(path));
			continue;
		}
		if (/\.(ts|tsx)$/u.test(entry)) {
			files.push(path);
		}
	}

	return files;
}

describe("auto-review mode source guard", () => {
	it("does not branch on the removed autoReviewMode commit value", () => {
		const matches = SOURCE_ROOTS.flatMap((root) =>
			collectSourceFiles(root).flatMap((file) => {
				const source = readFileSync(file, "utf8");
				return [...source.matchAll(AUTO_REVIEW_COMMIT_BRANCH_PATTERN)].map((match) => ({
					file: relative(process.cwd(), file),
					match: match[0],
				}));
			}),
		);

		expect(matches).toEqual([]);
	});
});
