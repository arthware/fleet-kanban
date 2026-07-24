import { readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import { parseCardTypeManifest, resolveActiveSkillsForLane } from "../../../src/core/card-type";

describe("Card Type Schema & Logic", () => {
	it("should parse feature.md successfully", async () => {
		const featurePath = join(process.cwd(), "fleet/card-types/feature.md");
		const rawContent = await readFile(featurePath, "utf-8");
		const parsed = matter(rawContent);

		const manifest = parseCardTypeManifest({
			name: "feature",
			...parsed.data,
		});

		expect(manifest.name).toBe("feature");
		expect(manifest.description).toBe(
			"The default card workflow — design → build → ship, with a dormant verify lane.",
		);
		expect(manifest.phases).toHaveLength(4);

		// phase: design
		expect(manifest.phases[0]).toEqual({
			name: "design",
			lane: "backlog",
			skills: ["fleet-plan"],
			activation: "plan-flag",
			planMode: true,
		});

		// phase: build
		expect(manifest.phases[1]).toEqual({
			name: "build",
			lane: "in_progress",
			skills: ["fleet-implement"],
			activation: "default",
		});

		// phase: ship
		expect(manifest.phases[2]).toEqual({
			name: "ship",
			lane: "in_progress",
			skills: ["fleet-pr"],
			activation: "auto-review-pr",
		});

		// phase: verify
		expect(manifest.phases[3]).toEqual({
			name: "verify",
			lane: "review",
			skills: ["fleet-review"],
			activation: "dormant",
		});
	});

	it("should resolve active skills for lane feature combo table correctly", async () => {
		const featurePath = join(process.cwd(), "fleet/card-types/feature.md");
		const rawContent = await readFile(featurePath, "utf-8");
		const parsed = matter(rawContent);
		const manifest = parseCardTypeManifest({
			name: "feature",
			...parsed.data,
		});

		// Case 1: bare card in in_progress lane
		const bareInProgress = resolveActiveSkillsForLane(manifest, {
			lane: "in_progress",
			startInPlanMode: false,
			autoReviewEnabled: false,
		});
		expect(bareInProgress.skills).toEqual(["fleet-implement"]);
		expect(bareInProgress.planMode).toBe(false);

		// Case 2: --plan card in backlog lane
		const planBacklog = resolveActiveSkillsForLane(manifest, {
			lane: "backlog",
			startInPlanMode: true,
			autoReviewEnabled: false,
		});
		expect(planBacklog.skills).toEqual(["fleet-plan"]);
		expect(planBacklog.planMode).toBe(true);

		// Case 3: --plan card in in_progress lane
		const planInProgress = resolveActiveSkillsForLane(manifest, {
			lane: "in_progress",
			startInPlanMode: true,
			autoReviewEnabled: false,
		});
		expect(planInProgress.skills).toEqual(["fleet-implement"]);
		expect(planInProgress.planMode).toBe(false);

		// Case 4: --auto-review pr card in in_progress lane
		const prInProgress = resolveActiveSkillsForLane(manifest, {
			lane: "in_progress",
			startInPlanMode: false,
			autoReviewEnabled: true,
			autoReviewMode: "pr",
		});
		expect(prInProgress.skills).toEqual(["fleet-implement", "fleet-pr"]);
		expect(prInProgress.planMode).toBe(false);

		// Case 5: any card in review lane (verify phase is dormant)
		const anyReview = resolveActiveSkillsForLane(manifest, {
			lane: "review",
			startInPlanMode: false,
			autoReviewEnabled: true,
			autoReviewMode: "pr",
		});
		expect(anyReview.skills).toEqual([]);
		expect(anyReview.planMode).toBe(false);
	});
});
