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
