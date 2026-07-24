import { z } from "zod";

export const cardTypePhaseActivationSchema = z.enum(["default", "plan-flag", "auto-review-pr", "dormant"]);
export type CardTypePhaseActivation = z.infer<typeof cardTypePhaseActivationSchema>;

export const cardTypePhaseLaneSchema = z.enum(["backlog", "in_progress", "review", "done"]);
export type CardTypePhaseLane = z.infer<typeof cardTypePhaseLaneSchema>;

export const cardTypePhaseSchema = z.object({
	name: z.string(),
	lane: cardTypePhaseLaneSchema,
	skills: z.array(z.string()),
	activation: cardTypePhaseActivationSchema,
	planMode: z.boolean().optional(),
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

export function resolveActiveSkillsForLane(
	manifest: CardTypeManifest,
	options: {
		startInPlanMode?: boolean;
		autoReviewEnabled?: boolean;
		autoReviewMode?: string | null;
		lane: string;
	},
): { skills: string[]; planMode: boolean } {
	const { startInPlanMode = false, autoReviewEnabled = false, autoReviewMode, lane } = options;

	const activePhasesInLane = manifest.phases.filter((phase) => {
		if (phase.lane !== lane) {
			return false;
		}

		switch (phase.activation) {
			case "default":
				return true;
			case "plan-flag":
				return startInPlanMode === true;
			case "auto-review-pr":
				return autoReviewEnabled === true && autoReviewMode === "pr";
			case "dormant":
				return false;
			default:
				return false;
		}
	});

	const skills = activePhasesInLane.flatMap((phase) => phase.skills);
	const planMode = activePhasesInLane.some((phase) => phase.planMode === true);

	return { skills, planMode };
}
