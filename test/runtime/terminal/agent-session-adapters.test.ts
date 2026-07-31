import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ClaudeHooksSettings } from "../../../src/agents/claude/hook-settings";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { createGitProcessEnv } from "../../../src/core/git-process-env";
import { prepareAgentLaunch, toBracketedPaste } from "../../../src/terminal/agent-session-adapters";

const originalHome = process.env.HOME;
const originalAppData = process.env.APPDATA;
const originalLocalAppData = process.env.LOCALAPPDATA;
let tempHome: string | null = null;
const originalArgv = [...process.argv];
const originalExecArgv = [...process.execArgv];
const originalExecPath = process.execPath;

function setupTempHome(): string {
	tempHome = mkdtempSync(join(tmpdir(), "kanban-agent-adapters-"));
	process.env.HOME = tempHome;
	return tempHome;
}

function setKanbanProcessContext(): void {
	process.argv = ["node", "/Users/example/repo/dist/cli.js"];
	process.execArgv = [];
	Object.defineProperty(process, "execPath", {
		configurable: true,
		value: "/usr/local/bin/node",
	});
}

function getCodexConfigOverrideValues(args: string[], key: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "-c" || arg === "--config") {
			const next = args[index + 1];
			if (typeof next === "string" && next.startsWith(`${key}=`)) {
				values.push(next.slice(key.length + 1));
			}
			index += 1;
			continue;
		}
		if (arg.startsWith(`-c${key}=`)) {
			values.push(arg.slice(key.length + 3));
			continue;
		}
		if (arg.startsWith(`--config=${key}=`)) {
			values.push(arg.slice(key.length + 10));
		}
	}
	return values;
}

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "codex",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		agentSessionId: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (tempHome) {
		rmSync(tempHome, { recursive: true, force: true });
		tempHome = null;
	}
	if (originalAppData === undefined) {
		delete process.env.APPDATA;
	} else {
		process.env.APPDATA = originalAppData;
	}
	if (originalLocalAppData === undefined) {
		delete process.env.LOCALAPPDATA;
	} else {
		process.env.LOCALAPPDATA = originalLocalAppData;
	}
	process.argv = [...originalArgv];
	process.execArgv = [...originalExecArgv];
	Object.defineProperty(process, "execPath", {
		configurable: true,
		value: originalExecPath,
	});
});

describe("prepareAgentLaunch hook strategies", () => {
	it("given Codex prompt-ready PTY bytes from a real prompt, when the adapter detector sees them during attention review, then it emits the prompt-ready event", async () => {
		// given
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});
		const summary = createSummary({
			agentId: "codex",
			state: "awaiting_review",
			reviewReason: "attention",
		});

		// when
		const event = launch.detectOutputTransition?.(
			"\u001b[2mctrl-c to exit\u001b[22m\n  \u001b[32m›\u001b[39m ",
			summary,
		);

		// then
		expect(event).toEqual({ type: "agent.prompt-ready" });
	});

	it("given Codex is resting for human review, when prompt-like PTY bytes arrive, then the adapter reports no prompt-ready event", async () => {
		// given
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});
		const summary = createSummary({
			agentId: "codex",
			state: "awaiting_review",
			reviewReason: "exit",
		});

		// when
		const event = launch.detectOutputTransition?.("› ", summary);

		// then
		expect(event).toBeNull();
	});

	it("configures Codex hooks without legacy notify", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");

		const launchCommand = [launch.binary ?? "", ...launch.args].join(" ");
		expect(launchCommand).toContain("codex");
		expect(launchCommand).toContain("codex-hook");
		expect(launchCommand).toContain("hooks.UserPromptSubmit");
		expect(launchCommand).toContain("hooks.Stop");
		expect(launchCommand).toContain("hooks.PermissionRequest");
		expect(getCodexConfigOverrideValues(launch.args, "features.hooks")).toEqual(["true"]);
		expect(getCodexConfigOverrideValues(launch.args, "features.codex_hooks")).toEqual([]);
		const hookTrustState = getCodexConfigOverrideValues(launch.args, "hooks.state");
		expect(hookTrustState).toHaveLength(1);
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:user_prompt_submit:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:stop:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:permission_request:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:pre_tool_use:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:post_tool_use:0:0"');
		expect(hookTrustState[0]).toContain('trusted_hash="sha256:');
		expect(launchCommand).toContain("timeout=5");
		expect(launchCommand).not.toContain("codex-wrapper");
		expect(launchCommand).not.toContain("notify=");

		const wrapperPath = join(homedir(), ".cline", "kanban", "hooks", "codex", "codex-wrapper.mjs");
		expect(existsSync(wrapperPath)).toBe(false);
	});

	it("appends Kanban sidebar instructions for home Claude sessions", async () => {
		setupTempHome();
		setKanbanProcessContext();
		const launch = await prepareAgentLaunch({
			taskId: "__home_agent__:workspace-1:claude",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		const appendPromptIndex = launch.args.indexOf("--append-system-prompt");
		expect(appendPromptIndex).toBeGreaterThanOrEqual(0);
		expect(launch.args[appendPromptIndex + 1]).toContain("Kanban sidebar agent");
		expect(launch.args[appendPromptIndex + 1]).toContain(
			"'/usr/local/bin/node' '/Users/example/repo/dist/cli.js' task create",
		);
	});

	it("appends Kanban sidebar instructions for home Codex sessions", async () => {
		setupTempHome();
		setKanbanProcessContext();
		const launch = await prepareAgentLaunch({
			taskId: "__home_agent__:workspace-1:codex",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		const developerInstructions = getCodexConfigOverrideValues(launch.args, "developer_instructions");
		expect(developerInstructions).toHaveLength(1);
		expect(developerInstructions[0]).toContain("Kanban sidebar agent");
		expect(developerInstructions[0]).toContain("'/usr/local/bin/node' '/Users/example/repo/dist/cli.js' task create");
		expect(getCodexConfigOverrideValues(launch.args, "check_for_update_on_startup")).toEqual(["false"]);
	});

	it("disables Codex startup update checks for Kanban-launched sessions", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-updates",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		expect(getCodexConfigOverrideValues(launch.args, "check_for_update_on_startup")).toEqual(["false"]);
	});

	it("preserves an explicit Codex update-check override", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-custom-update-check",
			agentId: "codex",
			binary: "codex",
			args: ["-c", "check_for_update_on_startup=true"],
			cwd: "/tmp",
			prompt: "",
		});

		expect(getCodexConfigOverrideValues(launch.args, "check_for_update_on_startup")).toEqual(["true"]);
	});

	it("writes Claude settings with explicit permission hook", async () => {
		setupTempHome();
		await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		const settingsPath = join(homedir(), ".cline", "kanban", "hooks", "claude", "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as ClaudeHooksSettings;
		expect(settings.hooks).toBeDefined();
		expect(settings.hooks?.PermissionRequest).toBeDefined();
		expect(settings.hooks?.PreToolUse).toBeDefined();
		expect(settings.hooks?.PostToolUse).toBeDefined();
		expect(settings.hooks?.PostToolUseFailure).toBeDefined();

		// Structural validation: every event array entry must be an object with a `hooks` array
		// where each element has type "command" and a string command.
		for (const [_, entries] of Object.entries(settings.hooks ?? {})) {
			expect(Array.isArray(entries)).toBe(true);
			for (const entry of entries) {
				expect(entry).toBeTypeOf("object");
				expect(entry).not.toBeNull();
				expect(entry).toHaveProperty("hooks");
				expect(Array.isArray(entry.hooks)).toBe(true);
				for (const hook of entry.hooks) {
					expect(hook).toBeTypeOf("object");
					expect(hook).not.toBeNull();
					expect(hook.type).toBe("command");
					expect(typeof hook.command).toBe("string");
				}
			}
		}
	});

	it("given a card selects Gemini CLI, when preparing launch with a prompt and hooks, then Gemini runs non-interactively with hook state forwarding", async () => {
		// given
		setupTempHome();
		const prompt = "Implement the billing export";

		// when
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "gemini",
			binary: "gemini",
			args: [],
			cwd: "/tmp",
			prompt,
			workspaceId: "workspace-1",
		});

		// then
		expect(launch.args).toEqual(["-i", prompt]);
		expect(launch.deferredStartupInput).toBeUndefined();
		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");
		expect(launch.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toContain("settings.json");

		const settingsPath = join(homedir(), ".cline", "kanban", "hooks", "gemini", "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
			security?: { folderTrust?: { enabled?: boolean } };
		};
		const afterToolCommand = settings.hooks?.AfterTool?.[0]?.hooks?.[0]?.command;
		expect(afterToolCommand).toContain("hooks");
		expect(afterToolCommand).toContain("gemini-hook");
		expect(settings.security?.folderTrust?.enabled).toBe(false);
		const hookScriptPath = join(homedir(), ".cline", "kanban", "hooks", "gemini", "gemini-hook.mjs");
		expect(existsSync(hookScriptPath)).toBe(false);
	});

	it("given a Gemini launch with no workspace/hook context, when preparing the launch, then folder-trust is still disabled via system settings", async () => {
		// given
		setupTempHome();

		// when
		const launch = await prepareAgentLaunch({
			taskId: "task-gemini-no-workspace",
			agentId: "gemini",
			binary: "gemini",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		// then
		expect(launch.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toContain("settings.json");
		const settingsPath = join(homedir(), ".cline", "kanban", "hooks", "gemini", "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			hooks?: unknown;
			security?: { folderTrust?: { enabled?: boolean } };
		};
		expect(settings.security?.folderTrust?.enabled).toBe(false);
		expect(settings.hooks).toBeUndefined();
	});

	it("materializes task images for CLI prompts", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-images",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Inspect the attached design",
			images: [
				{
					id: "img-1",
					data: Buffer.from("hello").toString("base64"),
					mimeType: "image/png",
					name: "diagram.png",
				},
			],
		});

		const initialPrompt = launch.args.at(-1) ?? "";
		expect(initialPrompt).toContain("Attached reference images:");
		expect(initialPrompt).toContain("Task:\nInspect the attached design");

		const imagePathMatch = initialPrompt.match(/1\. (.+?) \(diagram\.png\)/);
		expect(imagePathMatch?.[1]).toBeDefined();
		const imagePath = imagePathMatch?.[1] ?? "";
		expect(existsSync(imagePath)).toBe(true);
		expect(readFileSync(imagePath).toString("utf8")).toBe("hello");
	});

	it("delivers Codex plan cards as a normal prompt prefixed with the Fleet plan directive", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-plan",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Audit the deployment pipeline",
		});

		expect(launch.args.at(-1)).toBe("Audit the deployment pipeline");
		expect(launch.args.join(" ")).not.toContain("/plan");
		expect(launch.deferredStartupInput).toBeUndefined();
	});

	it("keeps Codex non-plan startup prompts on the normal launch path", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-normal",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Implement the audit",
		});

		expect(launch.args.at(-1)).toBe("Implement the audit");
		expect(launch.deferredStartupInput).toBeUndefined();
	});

	it("given Gemini launch resumes a trashed card, when preparing launch, then Gemini resumes the latest session", async () => {
		// given
		setupTempHome();

		// when
		const launch = await prepareAgentLaunch({
			taskId: "task-gemini",
			agentId: "gemini",
			binary: "gemini",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});

		// then
		expect(launch.args).toEqual(expect.arrayContaining(["--resume", "latest"]));
	});

	it("adds resume flags for each agent", async () => {
		setupTempHome();

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(codexLaunch.args).toEqual(expect.arrayContaining(["resume", "--last"]));

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(claudeLaunch.args).toContain("--continue");
	});

	it("places Codex hook config before the resume subcommand", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-resume-hooks",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
			workspaceId: "workspace-1",
		});

		const resumeIndex = launch.args.indexOf("resume");
		expect(resumeIndex).toBeGreaterThan(0);
		for (const key of [
			"features.hooks",
			"hooks.state",
			"hooks.UserPromptSubmit",
			"hooks.Stop",
			"hooks.PermissionRequest",
			"hooks.PreToolUse",
			"hooks.PostToolUse",
		]) {
			const configIndex = launch.args.findIndex((arg) => arg.startsWith(`${key}=`));
			expect(configIndex).toBeGreaterThan(-1);
			expect(configIndex).toBeLessThan(resumeIndex);
		}
	});

	it("given Gemini autonomous mode is enabled, when preparing launch, then Gemini receives the yolo flag", async () => {
		// given
		setupTempHome();

		// when
		const launch = await prepareAgentLaunch({
			taskId: "task-gemini-auto",
			agentId: "gemini",
			binary: "gemini",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});

		// then
		expect(launch.args).toContain("--yolo");
	});

	it("applies autonomous mode flags in adapters for surviving CLIs", async () => {
		setupTempHome();

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude-auto",
			agentId: "claude",
			binary: "claude",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		const permissionModeIndex = claudeLaunch.args.indexOf("--permission-mode");
		expect(permissionModeIndex).toBeGreaterThan(-1);
		expect(claudeLaunch.args[permissionModeIndex + 1]).toBe("auto");
		expect(claudeLaunch.args).not.toContain("--dangerously-skip-permissions");
		expect(claudeLaunch.env.CLAUDE_CODE_ENABLE_AUTO_MODE).toBe("1");

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex-auto",
			agentId: "codex",
			binary: "codex",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(codexLaunch.args).toContain("--dangerously-bypass-approvals-and-sandbox");
	});

	it("does not add a Claude permission mode when args already set one", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-explicit-mode",
			agentId: "claude",
			binary: "claude",
			args: ["--permission-mode", "acceptEdits"],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(launch.args.filter((arg) => arg === "--permission-mode")).toHaveLength(1);
		expect(launch.args).not.toContain("auto");
	});

	it("delivers Claude plan cards as a normal prompt prefixed with the Fleet plan directive", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-plan",
			agentId: "claude",
			binary: "claude",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "Design the migration path",
			agentModel: "claude-haiku-4-5",
		});
		expect(launch.args).not.toContain("--permission-mode");
		expect(launch.args).not.toContain("plan");
		expect(launch.args).toContain("--dangerously-skip-permissions");
		expect(launch.args).not.toContain("--allow-dangerously-skip-permissions");
		expect(launch.args.at(-1)).toBe("Design the migration path");
		expect(launch.deferredStartupInput).toBeUndefined();
		expect(launch.env.CLAUDE_CODE_ENABLE_AUTO_MODE).toBe("1");
	});

	it("delivers the Fleet plan directive for Claude plan cards with no prompt text", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-plan-empty",
			agentId: "claude",
			binary: "claude",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});

		const permissionModeIndex = launch.args.indexOf("--permission-mode");
		expect(launch.args[permissionModeIndex + 1]).not.toBe("plan");
		expect(launch.args.at(-1)).toBe("auto");
		expect(launch.deferredStartupInput).toBeUndefined();
	});

	it("preserves an explicit Claude bypass arg for Fleet plan cards", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-plan-bypass",
			agentId: "claude",
			binary: "claude",
			args: ["--dangerously-skip-permissions"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "Document the approach",
		});

		expect(launch.args).toContain("--dangerously-skip-permissions");
		expect(launch.args).not.toContain("--permission-mode");
		expect(launch.args.at(-1)).toBe("Document the approach");
		expect(launch.deferredStartupInput).toBeUndefined();
	});

	it("starts a fresh Claude session under a minted session id", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-fresh-id",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			agentSessionId: "11111111-2222-3333-4444-555555555555",
		});

		const sessionIdIndex = launch.args.indexOf("--session-id");
		expect(sessionIdIndex).toBeGreaterThan(-1);
		expect(launch.args[sessionIdIndex + 1]).toBe("11111111-2222-3333-4444-555555555555");
		expect(launch.args).not.toContain("--resume");
		expect(launch.args).not.toContain("--continue");
	});

	it("starts a fresh Claude trash restore under a minted session id instead of continuing by heuristic", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-fresh-trash-id",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			agentSessionId: "fresh-trash-session",
			resumeFromTrash: true,
		});

		const sessionIdIndex = launch.args.indexOf("--session-id");
		expect(sessionIdIndex).toBeGreaterThan(-1);
		expect(launch.args[sessionIdIndex + 1]).toBe("fresh-trash-session");
		expect(launch.args).not.toContain("--resume");
		expect(launch.args).not.toContain("--continue");
	});

	it("resumes a Claude session by its stored session id", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-resume-id",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			agentSessionId: "stored-claude-id",
			resumeSession: true,
		});

		const resumeIndex = launch.args.indexOf("--resume");
		expect(resumeIndex).toBeGreaterThan(-1);
		expect(launch.args[resumeIndex + 1]).toBe("stored-claude-id");
		expect(launch.args).not.toContain("--session-id");
	});

	it("resumes a Codex session by its stored session id", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-resume-id",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			agentSessionId: "stored-codex-id",
			resumeSession: true,
		});

		const resumeIndex = launch.args.indexOf("resume");
		expect(resumeIndex).toBeGreaterThan(-1);
		expect(launch.args).toContain("stored-codex-id");
		expect(launch.args).not.toContain("--last");
	});

	it("resumes a Gemini session by its stored session id", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-gemini-resume-id",
			agentId: "gemini",
			binary: "gemini",
			args: [],
			cwd: "/tmp",
			prompt: "",
			agentSessionId: "stored-gemini-id",
			resumeSession: true,
		});

		const resumeIndex = launch.args.indexOf("--resume");
		expect(resumeIndex).toBeGreaterThan(-1);
		expect(launch.args[resumeIndex + 1]).toBe("stored-gemini-id");
	});

	it("does not pass any resume flag for a fresh Codex session", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-fresh",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		expect(launch.args).not.toContain("resume");
		expect(launch.args).not.toContain("--last");
	});

	it("falls back to Claude's heuristic continue when resuming without a session id", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-resume-no-id",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeSession: true,
			resumeFromTrash: true,
		});

		expect(launch.args).toContain("--continue");
		expect(launch.args).not.toContain("--resume");
		expect(launch.args).not.toContain("--session-id");
	});

	it("preserves explicit autonomous args when autonomous mode is disabled", async () => {
		setupTempHome();

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude-no-auto",
			agentId: "claude",
			binary: "claude",
			args: ["--dangerously-skip-permissions"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(claudeLaunch.args).toContain("--dangerously-skip-permissions");

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex-no-auto",
			agentId: "codex",
			binary: "codex",
			args: ["--dangerously-bypass-approvals-and-sandbox"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(codexLaunch.args).toContain("--dangerously-bypass-approvals-and-sandbox");

		const geminiLaunch = await prepareAgentLaunch({
			taskId: "task-gemini-no-auto",
			agentId: "gemini",
			binary: "gemini",
			args: ["--yolo"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(geminiLaunch.args).toContain("--yolo");
	});
});

describe("toBracketedPaste", () => {
	it("wraps text in bracketed-paste markers", () => {
		expect(toBracketedPaste("hello there")).toBe("[200~hello there[201~");
	});

	it("never appends a submit Enter — the carriage return is written separately", () => {
		// A carriage return fused onto the paste-end marker (…[201~\r) is swallowed as
		// paste content by Claude Code's Ink TUI, so the paste frame must exclude it;
		// the submit Enter is a distinct PTY write a tick later.
		expect(toBracketedPaste("line one")).not.toContain("\r");
	});
});

function getFlagValue(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

function countFlag(args: string[], flag: string): number {
	return args.filter((arg) => arg === flag).length;
}

describe("per-card agent model", () => {
	it("launches a Claude session on the card's chosen model via --model", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-model-claude",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "do the mechanical thing",
			agentModel: "claude-haiku-4-5",
		});

		expect(getFlagValue(launch.args, "--model")).toBe("claude-haiku-4-5");
		expect(countFlag(launch.args, "--model")).toBe(1);
	});

	it("launches a Codex session on the card's chosen model via --model", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-model-codex",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "do the mechanical thing",
			agentModel: "gpt-5-codex",
		});

		expect(getFlagValue(launch.args, "--model")).toBe("gpt-5-codex");
		expect(countFlag(launch.args, "--model")).toBe(1);
	});

	it("does not pass --model when the card has no agent model", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-model-default",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "use the default model",
		});

		expect(launch.args).not.toContain("--model");
	});

	it("lets an explicit user --model win over the card's agent model", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-model-explicit",
			agentId: "claude",
			binary: "claude",
			args: ["--model", "user-chosen-model"],
			cwd: "/tmp",
			prompt: "explicit wins",
			agentModel: "claude-haiku-4-5",
		});

		expect(getFlagValue(launch.args, "--model")).toBe("user-chosen-model");
		expect(countFlag(launch.args, "--model")).toBe(1);
	});
});

function readClaudeSettings(): Partial<ClaudeHooksSettings> {
	const settingsPath = join(homedir(), ".cline", "kanban", "hooks", "claude", "settings.json");
	return JSON.parse(readFileSync(settingsPath, "utf8")) as Partial<ClaudeHooksSettings>;
}

function findBashGuardHook(
	settings: Partial<ClaudeHooksSettings>,
): { matcher?: string; hooks?: Array<{ command?: string }> } | undefined {
	return (settings.hooks?.PreToolUse ?? []).find(
		(entry) =>
			entry.matcher === "Bash" &&
			(entry.hooks ?? []).some((h) => (h.command ?? "").includes("hooks") && (h.command ?? "").includes("guard")),
	);
}

describe("prepareAgentLaunch — tiered autonomous permissions", () => {
	const bedrockKeys = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"] as const;
	const savedProviderEnv: Record<string, string | undefined> = {};

	function clearProviderEnv(): void {
		for (const key of bedrockKeys) {
			savedProviderEnv[key] = process.env[key];
			delete process.env[key];
		}
	}

	function restoreProviderEnv(): void {
		for (const key of bedrockKeys) {
			if (savedProviderEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedProviderEnv[key];
			}
		}
	}

	it("gives a weak model on the Anthropic API a real bypass behind the Bash-guard hook", async () => {
		setupTempHome();
		clearProviderEnv();
		try {
			const launch = await prepareAgentLaunch({
				taskId: "task-weak-model",
				agentId: "claude",
				binary: "claude",
				args: [],
				autonomousModeEnabled: true,
				cwd: "/tmp",
				prompt: "",
				workspaceId: "workspace-1",
				agentModel: "claude-haiku-4-5",
			});

			expect(launch.args).toContain("--dangerously-skip-permissions");
			expect(launch.args).not.toContain("--permission-mode");

			const guard = findBashGuardHook(readClaudeSettings());
			expect(guard).toBeDefined();
		} finally {
			restoreProviderEnv();
		}
	});

	it("keeps a capable model on --permission-mode auto with no guard hook (no #532 regression)", async () => {
		setupTempHome();
		clearProviderEnv();
		try {
			const launch = await prepareAgentLaunch({
				taskId: "task-capable-model",
				agentId: "claude",
				binary: "claude",
				args: [],
				autonomousModeEnabled: true,
				cwd: "/tmp",
				prompt: "",
				workspaceId: "workspace-1",
				agentModel: "claude-opus-4-8",
			});

			const permissionModeIndex = launch.args.indexOf("--permission-mode");
			expect(permissionModeIndex).toBeGreaterThan(-1);
			expect(launch.args[permissionModeIndex + 1]).toBe("auto");
			expect(launch.args).not.toContain("--dangerously-skip-permissions");

			expect(findBashGuardHook(readClaudeSettings())).toBeUndefined();
		} finally {
			restoreProviderEnv();
		}
	});

	it("keeps auto mode for a weak model when a cloud-provider backend is configured", async () => {
		setupTempHome();
		clearProviderEnv();
		process.env.CLAUDE_CODE_USE_BEDROCK = "1";
		try {
			const launch = await prepareAgentLaunch({
				taskId: "task-weak-bedrock",
				agentId: "claude",
				binary: "claude",
				args: [],
				autonomousModeEnabled: true,
				cwd: "/tmp",
				prompt: "",
				workspaceId: "workspace-1",
				agentModel: "claude-haiku-4-5",
			});

			const permissionModeIndex = launch.args.indexOf("--permission-mode");
			expect(permissionModeIndex).toBeGreaterThan(-1);
			expect(launch.args[permissionModeIndex + 1]).toBe("auto");
			expect(launch.args).not.toContain("--dangerously-skip-permissions");
			expect(findBashGuardHook(readClaudeSettings())).toBeUndefined();
		} finally {
			restoreProviderEnv();
		}
	});

	it("uses Fleet plan directive with write-capable guarded bypass for a weak model plan card", async () => {
		setupTempHome();
		clearProviderEnv();
		try {
			const launch = await prepareAgentLaunch({
				taskId: "task-weak-plan",
				agentId: "claude",
				binary: "claude",
				args: [],
				autonomousModeEnabled: true,
				cwd: "/tmp",
				prompt: "Write the rollout design",
				workspaceId: "workspace-1",
				agentModel: "claude-haiku-4-5",
			});

			expect(launch.args).not.toContain("--permission-mode");
			expect(launch.args).not.toContain("plan");
			expect(launch.args).toContain("--dangerously-skip-permissions");
			expect(launch.args.at(-1)).toBe("Write the rollout design");
			expect(launch.deferredStartupInput).toBeUndefined();
			expect(findBashGuardHook(readClaudeSettings())).toBeDefined();
		} finally {
			restoreProviderEnv();
		}
	});
});

function initGitRepoWithOrigin(originUrl: string | null): string {
	// Sanitize the ambient env (this suite may itself run from inside a git hook, which
	// leaks GIT_DIR/GIT_INDEX_FILE and would otherwise hijack these repo-scoped commands).
	const gitEnv = createGitProcessEnv();
	const cwd = mkdtempSync(join(tmpdir(), "kanban-agent-adapters-gh-env-"));
	execFileSync("git", ["init"], { cwd, env: gitEnv });
	if (originUrl) {
		execFileSync("git", ["remote", "add", "origin", originUrl], { cwd, env: gitEnv });
	}
	return cwd;
}

describe("prepareAgentLaunch — card gh environment", () => {
	let repoDir: string | null = null;

	afterEach(() => {
		if (repoDir) {
			rmSync(repoDir, { recursive: true, force: true });
			repoDir = null;
		}
	});

	it("given a card agent launch in a worktree whose origin is a GitHub fork, when the launch env is prepared, then GH_REPO targets the fork and GH_PROMPT_DISABLED is set", async () => {
		// given
		repoDir = initGitRepoWithOrigin("https://github.com/arthware/fleet-kanban.git");

		// when
		const launch = await prepareAgentLaunch({
			taskId: "task-gh-env",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: repoDir,
			prompt: "",
			workspaceId: "workspace-1",
		});

		// then
		expect(launch.env.GH_REPO).toBe("arthware/fleet-kanban");
		expect(launch.env.GH_PROMPT_DISABLED).toBe("1");
	});

	it("given a card agent launch in a worktree with no resolvable origin remote, when the launch env is prepared, then GH_REPO is absent but GH_PROMPT_DISABLED is still set", async () => {
		// given
		repoDir = initGitRepoWithOrigin(null);

		// when
		const launch = await prepareAgentLaunch({
			taskId: "task-gh-env-no-origin",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: repoDir,
			prompt: "",
			workspaceId: "workspace-1",
		});

		// then
		expect(launch.env.GH_REPO).toBeUndefined();
		expect(launch.env.GH_PROMPT_DISABLED).toBe("1");
	});

	it("given a home-agent sidebar session, when the launch env is prepared, then neither GH_REPO nor GH_PROMPT_DISABLED are set", async () => {
		// given
		repoDir = initGitRepoWithOrigin("https://github.com/arthware/fleet-kanban.git");

		// when
		const launch = await prepareAgentLaunch({
			taskId: "__home_agent__:workspace-1:claude",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: repoDir,
			prompt: "",
		});

		// then
		expect(launch.env.GH_REPO).toBeUndefined();
		expect(launch.env.GH_PROMPT_DISABLED).toBeUndefined();
	});
});
