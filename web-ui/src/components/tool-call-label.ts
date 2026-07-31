/**
 * Render a tool call as the compact `toolName(input)` label a card shows while its
 * agent works — `Read(src/index.ts)` rather than a bare `src/index.ts`.
 *
 * This has nothing to do with any particular harness: it formats the tool name and
 * input summary that every driver's observation already carries. It previously lived in
 * the Cline SDK boundary purely because that is where it was first written, and was lost
 * with that directory when the unused harnesses were retired — which quietly dropped the
 * tool name from every card's activity line, for every agent.
 */
export function formatToolCallLabel(toolName: string | null | undefined, inputSummary: string | null | undefined) {
	const normalizedToolName = typeof toolName === "string" && toolName.trim().length > 0 ? toolName.trim() : "unknown";
	const normalizedInputSummary = typeof inputSummary === "string" ? inputSummary.trim() : "";
	return normalizedInputSummary ? `${normalizedToolName}(${normalizedInputSummary})` : normalizedToolName;
}
