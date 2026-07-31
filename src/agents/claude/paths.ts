export const CLAUDE_SKILLS_RELATIVE_PATH = ".claude/skills";

export function isClaudeTranscriptPath(path: string): boolean {
	return path.replaceAll("\\", "/").toLowerCase().includes("/.claude/");
}
