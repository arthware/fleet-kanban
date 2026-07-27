import { readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import { parseCardTypeManifest, resolveLaneEntrySkills, resolveStartActiveSkills } from "../../../src/core/card-type";

describe("Card Type Schema & Logic", () => {
	it("should parse build.md successfully", async () => {
		const buildPath = join(process.cwd(), "fleet/card-types/build.md");
		const rawContent = await readFile(buildPath, "utf-8");
		const parsed = matter(rawContent);

		const manifest = parseCardTypeManifest({
			name: "build",
			...parsed.data,
		});

		expect(manifest.name).toBe("build");
		expect(manifest.description).toBe(
			"The default card workflow — implement, then ship a PR when auto-review is on.",
		);
		expect(manifest.phases).toHaveLength(3);

		expect(manifest.phases[0]).toEqual({
			name: "build",
			lane: "in_progress",
			skills: ["fleet-implement"],
			activation: "default",
		});

		expect(manifest.phases[1]).toEqual({
			name: "ship",
			lane: "in_progress",
			skills: ["fleet-pr"],
			activation: "auto-review-pr",
		});

		expect(manifest.phases[2]).toEqual({
			name: "verify",
			lane: "review",
			skills: ["fleet-review"],
			activation: "dormant",
		});
	});

	it("should parse plan.md successfully", async () => {
		const planPath = join(process.cwd(), "fleet/card-types/plan.md");
		const rawContent = await readFile(planPath, "utf-8");
		const parsed = matter(rawContent);

		const manifest = parseCardTypeManifest({
			name: "plan",
			...parsed.data,
		});

		expect(manifest.name).toBe("plan");
		expect(manifest.phases).toHaveLength(2);

		expect(manifest.phases[0]).toEqual({
			name: "design",
			lane: "in_progress",
			skills: ["fleet-plan"],
			activation: "default",
		});

		expect(manifest.phases[1]).toEqual({
			name: "verify",
			lane: "review",
			skills: ["fleet-review"],
			activation: "dormant",
		});
	});

	it("should resolve start active skills correctly (lane-free)", async () => {
		const buildPath = join(process.cwd(), "fleet/card-types/build.md");
		const buildRawContent = await readFile(buildPath, "utf-8");
		const buildParsed = matter(buildRawContent);
		const buildManifest = parseCardTypeManifest({
			name: "build",
			...buildParsed.data,
		});

		// Case 1: bare card
		const bare = resolveStartActiveSkills(buildManifest, {});
		expect(bare).toEqual(["fleet-implement"]);

		// Case 2: --auto-review pr card
		const pr = resolveStartActiveSkills(buildManifest, {
			autoReviewEnabled: true,
			autoReviewMode: "pr",
		});
		expect(pr).toEqual(["fleet-implement", "fleet-pr"]);

		const planPath = join(process.cwd(), "fleet/card-types/plan.md");
		const planRawContent = await readFile(planPath, "utf-8");
		const planParsed = matter(planRawContent);
		const planManifest = parseCardTypeManifest({
			name: "plan",
			...planParsed.data,
		});

		// Case 3: --type plan card
		const plan = resolveStartActiveSkills(planManifest, {});
		expect(plan).toEqual(["fleet-plan"]);
	});

	it("should resolve lane entry skills correctly", async () => {
		const buildPath = join(process.cwd(), "fleet/card-types/build.md");
		const buildRawContent = await readFile(buildPath, "utf-8");
		const buildParsed = matter(buildRawContent);
		const buildManifest = parseCardTypeManifest({
			name: "build",
			...buildParsed.data,
		});

		const planPath = join(process.cwd(), "fleet/card-types/plan.md");
		const planRawContent = await readFile(planPath, "utf-8");
		const planParsed = matter(planRawContent);
		const planManifest = parseCardTypeManifest({
			name: "plan",
			...planParsed.data,
		});

		expect(resolveLaneEntrySkills(buildManifest, "review")).toEqual(["fleet-review"]);
		expect(resolveLaneEntrySkills(planManifest, "review")).toEqual(["fleet-review"]);

		const mockManifest = {
			name: "mock",
			description: "mock",
			phases: [
				{
					name: "test",
					lane: "review" as const,
					skills: ["fleet-test"],
					activation: "dormant" as const,
				},
			],
		};
		expect(resolveLaneEntrySkills(mockManifest, "review")).toEqual(["fleet-test"]);
	});
});
