import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	CONSTITUTION_DIRECTIVE_HEADER,
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
});
