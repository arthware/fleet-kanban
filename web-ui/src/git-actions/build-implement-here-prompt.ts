// The approval-to-build prompt injected into a plan card's still-live session
// when the operator approves its design doc and clicks "Implement here". The
// same agent that wrote the plan re-reads its own committed doc and starts
// building — no fresh agent re-priming the codebase from zero. The resolved doc
// path is interpolated so the agent reads the exact file it produced.
export function buildImplementHerePrompt(designDocPath: string): string {
	return [
		`The plan in \`${designDocPath}\` is approved.`,
		"Re-read it and implement it now in this same session.",
		"Keep all existing tests green.",
		"When done, commit with a `feat:`/`fix:` subject and open a PR against production-line.",
	].join(" ");
}
