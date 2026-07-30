import { buildHookCommand, buildHooksCommand } from "../../terminal/agent-session-adapters";

export type ClaudeHookEvent =
	| "Stop"
	| "SubagentStop"
	| "PreToolUse"
	| "PermissionRequest"
	| "PostToolUse"
	| "PostToolUseFailure"
	| "Notification"
	| "UserPromptSubmit";

export interface ClaudeHookCommand {
	type: "command";
	command: string;
	timeout?: number;
}

export interface ClaudeHookMatcher {
	matcher?: string;
	hooks: ClaudeHookCommand[];
}

export interface ClaudeHooksSettings {
	hooks: Record<ClaudeHookEvent, ClaudeHookMatcher[]>;
}

export function buildClaudeHookSettings(bashGuardEnabled: boolean): ClaudeHooksSettings {
	const preToolUseHooks: ClaudeHookMatcher[] = [
		{
			matcher: "*",
			hooks: [{ type: "command" as const, command: buildHookCommand("activity", { source: "claude" }) }],
		},
		...(bashGuardEnabled
			? [
					{
						matcher: "Bash",
						hooks: [
							{
								type: "command" as const,
								command: buildHooksCommand(["guard", "--source", "claude"]),
							},
						],
					},
				]
			: []),
	];

	return {
		hooks: {
			Stop: [
				{ hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }] },
			],
			SubagentStop: [
				{ hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }] },
			],
			PreToolUse: preToolUseHooks,
			PermissionRequest: [
				{
					matcher: "*",
					hooks: [
						{
							type: "command",
							command: buildHookCommand("to_review", {
								source: "claude",
								notificationType: "permission_prompt",
							}),
						},
					],
				},
			],
			PostToolUse: [
				{
					matcher: "*",
					hooks: [
						{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) },
					],
				},
			],
			PostToolUseFailure: [
				{
					matcher: "*",
					hooks: [
						{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) },
					],
				},
			],
			Notification: [
				{
					matcher: "permission_prompt",
					hooks: [
						{
							type: "command",
							command: buildHookCommand("to_review", {
								source: "claude",
								notificationType: "permission_prompt",
							}),
						},
					],
				},
				{
					matcher: "*",
					hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }],
				},
			],
			UserPromptSubmit: [
				{
					hooks: [
						{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) },
					],
				},
			],
		},
	};
}
