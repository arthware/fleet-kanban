import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { z } from "zod";

export const cardTypePhaseActivationSchema = z.enum(["default", "auto-review-pr", "dormant"]);
export type CardTypePhaseActivation = z.infer<typeof cardTypePhaseActivationSchema>;

export const cardTypePhaseLaneSchema = z.enum(["backlog", "in_progress", "review", "done"]);
export type CardTypePhaseLane = z.infer<typeof cardTypePhaseLaneSchema>;

export const cardTypePhaseSchema = z.object({
	name: z.string(),
	lane: cardTypePhaseLaneSchema,
	skills: z.array(z.string()),
	activation: cardTypePhaseActivationSchema,
});
export type CardTypePhase = z.infer<typeof cardTypePhaseSchema>;

export const cardTypeManifestSchema = z.object({
	name: z.string(),
	description: z.string(),
	phases: z.array(cardTypePhaseSchema),
});
export type CardTypeManifest = z.infer<typeof cardTypeManifestSchema>;

export function parseCardTypeManifest(raw: unknown): CardTypeManifest {
	return cardTypeManifestSchema.parse(raw);
}

export function resolveStartActiveSkills(
	manifest: CardTypeManifest,
	flags: { autoReviewEnabled?: boolean; autoReviewMode?: string | null },
): string[] {
	return manifest.phases
		.filter((phase) => {
			switch (phase.activation) {
				case "default":
					return true;
				case "auto-review-pr":
					return flags.autoReviewEnabled === true && flags.autoReviewMode === "pr";
				case "dormant":
					return false;
				default:
					return false;
			}
		})
		.flatMap((phase) => phase.skills);
}

export function resolveLaneEntrySkills(manifest: CardTypeManifest, lane: string): string[] {
	return manifest.phases.filter((p) => p.lane === lane && p.activation === "dormant").flatMap((p) => p.skills);
}

export interface SkillValidation {
	name: string;
	status: "ok" | "MISSING" | "EMPTY-DIRECTIVE";
}

export interface PhaseValidation {
	name: string;
	lane: string;
	activation: string;
	skills: SkillValidation[];
}

export interface CardTypeValidationResult {
	isValid: boolean;
	phases: PhaseValidation[];
}

export function validateSkill(skillName: string, skillsDir: string): "ok" | "MISSING" | "EMPTY-DIRECTIVE" {
	const skillPath = join(skillsDir, skillName, "SKILL.md");
	if (!existsSync(skillPath)) {
		return "MISSING";
	}
	try {
		const fileContent = readFileSync(skillPath, "utf-8");
		const { data } = matter(fileContent);
		if (data && typeof data.directive === "string" && data.directive.trim() !== "") {
			return "ok";
		}
		return "EMPTY-DIRECTIVE";
	} catch {
		return "EMPTY-DIRECTIVE";
	}
}

export function validateCardType(manifest: CardTypeManifest, skillsDir: string): CardTypeValidationResult {
	let isValid = true;
	const phases: PhaseValidation[] = [];

	for (const phase of manifest.phases) {
		const skillValidations: SkillValidation[] = [];
		for (const skillName of phase.skills) {
			const status = validateSkill(skillName, skillsDir);
			if (status !== "ok") {
				isValid = false;
			}
			skillValidations.push({ name: skillName, status });
		}
		phases.push({
			name: phase.name,
			lane: phase.lane,
			activation: phase.activation,
			skills: skillValidations,
		});
	}

	return { isValid, phases };
}
