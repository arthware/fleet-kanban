import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	CONSTITUTION_DIRECTIVE_HEADER,
	extractInjectableConstitution,
	loadDoctrine,
	prependConstitution,
	type ReadFileIfExists,
} from "../../../src/prompts/doctrine";

/**
 * A fake filesystem seam backed by a path→content map. This is the whole external
 * dependency of the doctrine module — mock it here and nowhere else (Article 4).
 */
function fakeReader(files: Record<string, string>): ReadFileIfExists {
	return async (p: string) => (p in files ? files[p] : null);
}

const repoPath = "/repos/repo1";
const fleetRoot = "/fleet-root";
const inRepoPath = path.join(repoPath, "docs/architecture/constitution.md");
const rootFallbackPath = path.join(fleetRoot, ".fleet/doctrine/repo1/constitution.md");

describe("loadDoctrine", () => {
	it("given an in-repo constitution, when resolved, then it is returned tagged in-repo", async () => {
		// given
		const read = fakeReader({ [inRepoPath]: "# Constitution\nrepo1 in-repo" });
		// when
		const doctrine = await loadDoctrine({ repoPath, repoName: "repo1", fleetRoot }, read);
		// then
		expect(doctrine).toEqual({
			constitution: "# Constitution\nrepo1 in-repo",
			source: "in-repo",
			path: inRepoPath,
		});
	});

	it("given only a root-fallback constitution, when resolved, then it is returned tagged root-fallback", async () => {
		// given
		const read = fakeReader({ [rootFallbackPath]: "# Constitution\nrepo1 at root" });
		// when
		const doctrine = await loadDoctrine({ repoPath, repoName: "repo1", fleetRoot }, read);
		// then
		expect(doctrine).toEqual({
			constitution: "# Constitution\nrepo1 at root",
			source: "root-fallback",
			path: rootFallbackPath,
		});
	});

	it("given both in-repo and root-fallback, when resolved, then in-repo wins", async () => {
		// given
		const read = fakeReader({
			[inRepoPath]: "in-repo",
			[rootFallbackPath]: "at root",
		});
		// when
		const doctrine = await loadDoctrine({ repoPath, repoName: "repo1", fleetRoot }, read);
		// then
		expect(doctrine?.source).toBe("in-repo");
		expect(doctrine?.constitution).toBe("in-repo");
	});

	it("given no fleet root, when only in-repo is checked, then a missing repo doctrine resolves to null", async () => {
		// given — no fleetRoot means root-fallback cannot be attempted
		const read = fakeReader({ [rootFallbackPath]: "unreachable without fleetRoot" });
		// when
		const doctrine = await loadDoctrine({ repoPath }, read);
		// then
		expect(doctrine).toBeNull();
	});

	it("given neither location has a constitution, when resolved, then it returns null", async () => {
		// given
		const read = fakeReader({});
		// when
		const doctrine = await loadDoctrine({ repoPath, repoName: "repo1", fleetRoot }, read);
		// then
		expect(doctrine).toBeNull();
	});
});

describe("prependConstitution", () => {
	it("given a constitution, when prepended, then the prompt carries the header, the text, and a separator", async () => {
		// given
		const prompt = "Do the thing.";
		// when
		const result = prependConstitution(prompt, "# Constitution\nArticle 1…");
		// then
		expect(result).toBe(`${CONSTITUTION_DIRECTIVE_HEADER}\n\n# Constitution\nArticle 1…\n\n---\n\n${prompt}`);
	});

	it("given no constitution, when prepended, then the prompt is unchanged", async () => {
		// given
		const prompt = "Do the thing.";
		// when
		const result = prependConstitution(prompt, null);
		// then
		expect(result).toBe(prompt);
	});

	it("given a constitution with surrounding whitespace, when prepended, then it is trimmed", async () => {
		// given / when
		const result = prependConstitution("P", "\n\n# Constitution\n\n");
		// then
		expect(result).toBe(`${CONSTITUTION_DIRECTIVE_HEADER}\n\n# Constitution\n\n---\n\nP`);
	});

	it("given a constitution that becomes empty after stripping, when prepended, then the prompt is unchanged", () => {
		// given
		const prompt = "Do the thing.";
		const emptyConstitution = "<!-- only comment -->\n## Governance\nsome footer";
		// when
		const result = prependConstitution(prompt, emptyConstitution);
		// then
		expect(result).toBe(prompt);
	});
});

describe("extractInjectableConstitution", () => {
	it("should exclude HTML comments and ## Governance section onward while including all Article text", () => {
		const raw = `<!--
SYNC IMPACT REPORT
==================
Version change: 1.0.0
-->

# Constitution

## Article 1 — Concepts first
Do X.

## Governance
This is non-normative.`;

		const result = extractInjectableConstitution(raw);
		expect(result).toContain("# Constitution");
		expect(result).toContain("## Article 1 — Concepts first\nDo X.");
		expect(result).not.toContain("SYNC IMPACT REPORT");
		expect(result).not.toContain("## Governance");
		expect(result).not.toContain("This is non-normative.");
	});

	it("should return the full text if there are no HTML comments or Governance sections", () => {
		const raw = "# Just text\nNo comment, no governance.";
		const result = extractInjectableConstitution(raw);
		expect(result).toBe("# Just text\nNo comment, no governance.");
	});

	it("should handle case-insensitive matching for Governance heading", () => {
		const raw = "# Constitution\n\n## Article 1\nContent\n\n## goVeRnanCe\nMore content";
		const result = extractInjectableConstitution(raw);
		expect(result).toContain("# Constitution");
		expect(result).toContain("## Article 1\nContent");
		expect(result).not.toContain("## goVeRnanCe");
		expect(result).not.toContain("More content");
	});

	it("should handle multiple HTML comments and strip them all", () => {
		const raw = "<!-- first --># Hello<!-- second -->\nWorld<!-- third -->";
		const result = extractInjectableConstitution(raw);
		expect(result).toBe("# Hello\nWorld");
	});

	it("should not crash or return empty on an empty string", () => {
		expect(extractInjectableConstitution("")).toBe("");
	});
});
