import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PLAN_CARD_PROMPT_DIRECTIVE } from "../../../src/prompts/plan-card-directive";
import { prepareAgentLaunch, toBracketedPasteSubmission } from "../../../src/terminal/agent-session-adapters";

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

	it("given a Cursor home sidebar session, when it launches with a prompt, then the sidebar guidance is sent with the prompt", async () => {
		// given
		setupTempHome();
		setKanbanProcessContext();

		// when
		const launch = await prepareAgentLaunch({
			taskId: "__home_agent__:workspace-1:cursor",
			agentId: "cursor",
			binary: "cursor-agent",
			args: [],
			cwd: "/tmp",
			prompt: "Create a task for the failing login test",
		});

		// then
		const initialPrompt = launch.args.at(-1) ?? "";
		expect(initialPrompt).toContain("Kanban sidebar agent");
		expect(initialPrompt).toContain("Current home agent: `cursor`");
		expect(initialPrompt).toContain("cursor-agent mcp login linear");
		expect(initialPrompt).toContain("# User Request");
		expect(initialPrompt).toContain("Create a task for the failing login test");
	});

	it("given cursor-agent is installed, when a card selects Cursor and starts, then cursor-agent launches with prompt hooks and autonomous args", async () => {
		// given
		const cwd = setupTempHome();

		// when
		const launch = await prepareAgentLaunch({
			taskId: "task-cursor",
			agentId: "cursor",
			binary: "cursor-agent",
			args: [],
			autonomousModeEnabled: true,
			cwd,
			prompt: "Implement Cursor launch support",
			workspaceId: "workspace-1",
		});

		// then
		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-cursor");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");
		expect(launch.args).toContain("--force");
		expect(launch.args.at(-1)).toBe("Implement Cursor launch support");

		const hooksPath = join(cwd, ".cursor", "hooks.json");
		const config = JSON.parse(readFileSync(hooksPath, "utf8")) as {
			version?: number;
			hooks?: Record<string, Array<{ command?: string }>>;
		};
		expect(config.version).toBe(1);
		expect(config.hooks?.beforeSubmitPrompt?.[0]?.command).toContain("to_in_progress");
		expect(config.hooks?.beforeShellExecution?.[0]?.command).toContain("to_in_progress");
		expect(config.hooks?.afterFileEdit?.[0]?.command).toContain("activity");
		expect(config.hooks?.stop?.[0]?.command).toContain("to_review");
		expect(config.hooks?.stop?.[0]?.command).toContain("Waiting for review");
	});

	it("given cursor-agent starts a plan card, then Cursor receives a normal prompt and no native plan flag", async () => {
		// given
		const cwd = setupTempHome();

		// when
		const launch = await prepareAgentLaunch({
			taskId: "task-cursor-plan",
			agentId: "cursor",
			binary: "cursor-agent",
			args: [],
			autonomousModeEnabled: true,
			cwd,
			prompt: "Design Cursor plan handling",
			startInPlanMode: true,
			workspaceId: "workspace-1",
		});

		// then
		expect(launch.args).not.toContain("--plan");
		expect(launch.args).toContain("--force");
		expect(launch.args.at(-1)).toBe(`${PLAN_CARD_PROMPT_DIRECTIVE}Design Cursor plan handling`);
	});

	it("given cursor-agent starts a normal card, then Cursor launch args are unchanged", async () => {
		// given
		const cwd = setupTempHome();

		// when
		const launch = await prepareAgentLaunch({
			taskId: "task-cursor-normal",
			agentId: "cursor",
			binary: "cursor-agent",
			args: [],
			autonomousModeEnabled: true,
			cwd,
			prompt: "Implement Cursor plan handling",
			workspaceId: "workspace-1",
		});

		// then
		expect(launch.args).toContain("--force");
		expect(launch.args.at(-1)).toBe("Implement Cursor plan handling");
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
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			hooks?: Record<string, unknown>;
		};
		expect(settings.hooks?.PermissionRequest).toBeDefined();
		expect(settings.hooks?.PreToolUse).toBeDefined();
		expect(settings.hooks?.PostToolUse).toBeDefined();
		expect(settings.hooks?.PostToolUseFailure).toBeDefined();
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
		};
		const afterToolCommand = settings.hooks?.AfterTool?.[0]?.hooks?.[0]?.command;
		expect(afterToolCommand).toContain("hooks");
		expect(afterToolCommand).toContain("gemini-hook");
		const hookScriptPath = join(homedir(), ".cline", "kanban", "hooks", "gemini", "gemini-hook.mjs");
		expect(existsSync(hookScriptPath)).toBe(false);
	});

	it("writes OpenCode plugin with root-session filtering and permission hooks", async () => {
		setupTempHome();
		await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "opencode",
			binary: "opencode",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		const pluginPath = join(homedir(), ".cline", "kanban", "hooks", "opencode", "kanban.js");
		const plugin = readFileSync(pluginPath, "utf8");
		expect(plugin).toContain("parentID");
		expect(plugin).toContain('"permission.ask"');
		expect(plugin).toContain('"tool.execute.before"');
		expect(plugin).toContain('"tool.execute.after"');
		expect(plugin).toContain("session.status");
		expect(plugin).toContain("message.part.updated");
		expect(plugin).toContain("last_assistant_message");
		expect(plugin).toContain("--metadata-base64");
		expect(plugin).toContain('if (kind === "review")');
		expect(plugin).toContain('currentState = "idle"');
	});

	it("loads OpenCode preferred model from LOCALAPPDATA state and auth paths", async () => {
		const homePath = setupTempHome();
		const localAppDataPath = join(homePath, "AppData", "Local");
		process.env.LOCALAPPDATA = localAppDataPath;

		const statePath = join(localAppDataPath, "opencode", "state");
		mkdirSync(statePath, { recursive: true });
		writeFileSync(
			join(statePath, "model.json"),
			JSON.stringify(
				{
					recent: [
						{ providerID: "anthropic", modelID: "claude-3-7-sonnet" },
						{ providerID: "openai", modelID: "gpt-4o" },
					],
				},
				null,
				2,
			),
			"utf8",
		);

		const authPath = join(localAppDataPath, "opencode");
		mkdirSync(authPath, { recursive: true });
		writeFileSync(
			join(authPath, "auth.json"),
			JSON.stringify(
				{
					openai: { key: "sk-test" },
				},
				null,
				2,
			),
			"utf8",
		);

		const launch = await prepareAgentLaunch({
			taskId: "task-opencode-model",
			agentId: "opencode",
			binary: "opencode",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		const modelIndex = launch.args.indexOf("--model");
		expect(modelIndex).toBeGreaterThan(-1);
		expect(launch.args[modelIndex + 1]).toBe("openai/gpt-4o");
	});

	it("writes Droid settings with hook transitions and runtime autonomy mode", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "droid",
			binary: "droid",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");

		const settingsArgIndex = launch.args.indexOf("--settings");
		expect(settingsArgIndex).toBeGreaterThanOrEqual(0);
		const settingsPath = launch.args[settingsArgIndex + 1];
		expect(settingsPath).toBeDefined();

		const settings = JSON.parse(readFileSync(settingsPath ?? "", "utf8")) as {
			autonomyMode?: string;
			hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
		};
		expect(settings.autonomyMode).toBe("auto-high");
		expect(settings.hooks?.Stop?.[0]?.hooks?.[0]?.command).toContain("to_review");
		expect(settings.hooks?.Notification?.[0]?.hooks?.[0]?.command).toContain("activity");
		expect(settings.hooks?.Notification?.[1]?.hooks?.[0]?.command).toContain("to_review");
		expect(settings.hooks?.PreToolUse?.[0]?.matcher).toBe("*");
		expect(settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command).toContain("activity");
		const preToolInProgressHook = settings.hooks?.PreToolUse?.find(
			(hook) => hook.matcher === "Read|Grep|Glob|FetchUrl|WebSearch|Execute|Task|Edit|Create",
		);
		expect(preToolInProgressHook?.hooks?.[0]?.command).toContain("to_in_progress");
		const preToolReviewHook = settings.hooks?.PreToolUse?.find((hook) => hook.matcher === "AskUser");
		expect(preToolReviewHook?.hooks?.[0]?.command).toContain("to_review");
		expect(settings.hooks?.PostToolUse?.[0]?.matcher).toBe("*");
		expect(settings.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command).toContain("activity");
		const postToolInProgressHook = settings.hooks?.PostToolUse?.find((hook) => hook.matcher === "AskUser");
		expect(postToolInProgressHook?.hooks?.[0]?.command).toContain("to_in_progress");
		expect(settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toContain("to_in_progress");
	});

	it("writes Kiro agent hooks and uses a Kanban-managed soft planning prompt", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-kiro-1",
			agentId: "kiro",
			binary: "kiro-cli",
			args: ["chat"],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "Investigate deployment drift",
			startInPlanMode: true,
			workspaceId: "workspace-1",
		});

		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-kiro-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");
		expect(launch.args).toContain("--agent");
		expect(launch.args[launch.args.indexOf("--agent") + 1]).toBe("kanban");
		expect(launch.args).toContain("--trust-all-tools");
		const initialPrompt = launch.args.at(-1) ?? "";
		expect(initialPrompt).toContain("Do not modify files");
		expect(initialPrompt).toContain("Task:\nInvestigate deployment drift");

		const configPath = join(homedir(), ".kiro", "agents", "kanban.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as {
			tools?: string[];
			hooks?: Record<string, Array<{ command?: string }>>;
		};
		expect(config.tools).toEqual(["*"]);
		expect(config.hooks?.agentSpawn?.[0]?.command).toContain("to_in_progress");
		expect(config.hooks?.userPromptSubmit?.[0]?.command).toContain("to_in_progress");
		expect(config.hooks?.preToolUse?.[0]?.command).toContain("activity");
		expect(config.hooks?.preToolUse?.[1]?.command).toContain("to_in_progress");
		expect(config.hooks?.postToolUse?.[0]?.command).toContain("activity");
		expect(config.hooks?.stop?.[0]?.command).toContain("to_review");
		expect(config.hooks?.stop?.[0]?.command).toContain("Waiting for review");
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
			startInPlanMode: true,
		});

		expect(launch.args.at(-1)).toBe(`${PLAN_CARD_PROMPT_DIRECTIVE}Audit the deployment pipeline`);
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

	it("writes Cline hook scripts and injects --hooks-dir", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "cline",
			binary: "cline",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		const hooksDir = join(homedir(), ".cline", "kanban", "hooks", "cline");
		const notificationHookPath =
			process.platform === "win32" ? join(hooksDir, "Notification.ps1") : join(hooksDir, "Notification");
		const taskCompleteHookPath =
			process.platform === "win32" ? join(hooksDir, "TaskComplete.ps1") : join(hooksDir, "TaskComplete");
		const userPromptSubmitHookPath =
			process.platform === "win32" ? join(hooksDir, "UserPromptSubmit.ps1") : join(hooksDir, "UserPromptSubmit");
		const preToolUseHookPath =
			process.platform === "win32" ? join(hooksDir, "PreToolUse.ps1") : join(hooksDir, "PreToolUse");
		const postToolUseHookPath =
			process.platform === "win32" ? join(hooksDir, "PostToolUse.ps1") : join(hooksDir, "PostToolUse");

		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");

		const hooksDirArgIndex = launch.args.indexOf("--hooks-dir");
		expect(hooksDirArgIndex).toBeGreaterThanOrEqual(0);
		expect(launch.args[hooksDirArgIndex + 1]).toBe(hooksDir);

		expect(existsSync(notificationHookPath)).toBe(true);
		expect(existsSync(taskCompleteHookPath)).toBe(true);
		expect(existsSync(userPromptSubmitHookPath)).toBe(true);
		expect(existsSync(preToolUseHookPath)).toBe(true);
		expect(existsSync(postToolUseHookPath)).toBe(true);

		const notificationScript = readFileSync(notificationHookPath, "utf8");
		expect(notificationScript).toContain("hooks");
		expect(notificationScript).toContain("to_review");
		expect(notificationScript).toContain("user_attention");
		expect(notificationScript).toContain("completion_result");
		expect(notificationScript).toContain('{"cancel":false}');

		const taskCompleteScript = readFileSync(taskCompleteHookPath, "utf8");
		expect(taskCompleteScript).toContain("hooks");
		expect(taskCompleteScript).toContain("to_review");
		expect(taskCompleteScript).toContain('{"cancel":false}');

		const userPromptSubmitScript = readFileSync(userPromptSubmitHookPath, "utf8");
		expect(userPromptSubmitScript).toContain("hooks");
		expect(userPromptSubmitScript).toContain("to_in_progress");
		expect(userPromptSubmitScript).toContain('{"cancel":false}');

		const preToolUseScript = readFileSync(preToolUseHookPath, "utf8");
		expect(preToolUseScript).toContain("hooks");
		expect(preToolUseScript).toContain("activity");
		expect(preToolUseScript).toContain("to_in_progress");
		expect(preToolUseScript).toContain("to_review");
		expect(preToolUseScript).toContain("ask_followup_question");
		expect(preToolUseScript).toContain("plan_mode_respond");

		const postToolUseScript = readFileSync(postToolUseHookPath, "utf8");
		expect(postToolUseScript).toContain("hooks");
		expect(postToolUseScript).toContain("activity");
		expect(postToolUseScript).toContain("to_in_progress");
		expect(postToolUseScript).toContain("ask_followup_question");
		expect(postToolUseScript).toContain("plan_mode_respond");
	});

	it("given Cline CLI starts a plan card, then it receives the Fleet plan directive without --plan", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-cline-plan",
			agentId: "cline",
			binary: "cline",
			args: [],
			cwd: "/tmp",
			prompt: "Design native Cline plan handling",
			startInPlanMode: true,
		});

		expect(launch.args).not.toContain("--plan");
		expect(launch.args.at(-1)).toBe(`${PLAN_CARD_PROMPT_DIRECTIVE}Design native Cline plan handling`);
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

		const opencodeLaunch = await prepareAgentLaunch({
			taskId: "task-opencode",
			agentId: "opencode",
			binary: "opencode",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(opencodeLaunch.args).toContain("--continue");

		const droidLaunch = await prepareAgentLaunch({
			taskId: "task-droid",
			agentId: "droid",
			binary: "droid",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(droidLaunch.args).toContain("--resume");

		const kiroLaunch = await prepareAgentLaunch({
			taskId: "task-kiro",
			agentId: "kiro",
			binary: "kiro-cli",
			args: ["chat"],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(kiroLaunch.args).toContain("--resume");

		const cursorLaunch = await prepareAgentLaunch({
			taskId: "task-cursor",
			agentId: "cursor",
			binary: "cursor-agent",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(cursorLaunch.args).toContain("--continue");

		const clineLaunch = await prepareAgentLaunch({
			taskId: "task-cline",
			agentId: "cline",
			binary: "cline",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(clineLaunch.args).toContain("--continue");
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

	it("applies autonomous mode flags in adapters for non-droid CLIs", async () => {
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

		const kiroLaunch = await prepareAgentLaunch({
			taskId: "task-kiro-auto",
			agentId: "kiro",
			binary: "kiro-cli",
			args: ["chat"],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(kiroLaunch.args).toContain("--trust-all-tools");

		const cursorLaunch = await prepareAgentLaunch({
			taskId: "task-cursor-auto",
			agentId: "cursor",
			binary: "cursor-agent",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(cursorLaunch.args).toContain("--force");

		const clineLaunch = await prepareAgentLaunch({
			taskId: "task-cline-auto",
			agentId: "cline",
			binary: "cline",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(clineLaunch.args).toContain("--auto-approve-all");
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
			startInPlanMode: true,
		});
		expect(launch.args).not.toContain("--permission-mode");
		expect(launch.args).not.toContain("plan");
		expect(launch.args).toContain("--dangerously-skip-permissions");
		expect(launch.args).not.toContain("--allow-dangerously-skip-permissions");
		expect(launch.args.at(-1)).toBe(`${PLAN_CARD_PROMPT_DIRECTIVE}Design the migration path`);
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
			startInPlanMode: true,
		});

		const permissionModeIndex = launch.args.indexOf("--permission-mode");
		expect(launch.args[permissionModeIndex + 1]).not.toBe("plan");
		expect(launch.args.at(-1)).toBe(PLAN_CARD_PROMPT_DIRECTIVE.trim());
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
			startInPlanMode: true,
		});

		expect(launch.args).toContain("--dangerously-skip-permissions");
		expect(launch.args).not.toContain("--permission-mode");
		expect(launch.args.at(-1)).toBe(`${PLAN_CARD_PROMPT_DIRECTIVE}Document the approach`);
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

	it("resumes a Cursor session without appending the initial prompt", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-cursor-resume",
			agentId: "cursor",
			binary: "cursor-agent",
			args: [],
			cwd: "/tmp",
			prompt: "Original card prompt",
			resumeSession: true,
		});

		expect(launch.args).toContain("--continue");
		expect(launch.args).not.toContain("Original card prompt");
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

		const clineLaunch = await prepareAgentLaunch({
			taskId: "task-cline-no-auto",
			agentId: "cline",
			binary: "cline",
			args: ["--auto-approve-all"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(clineLaunch.args).toContain("--auto-approve-all");

		const kiroLaunch = await prepareAgentLaunch({
			taskId: "task-kiro-no-auto",
			agentId: "kiro",
			binary: "kiro-cli",
			args: ["chat", "--trust-all-tools"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(kiroLaunch.args).toContain("--trust-all-tools");

		const cursorLaunch = await prepareAgentLaunch({
			taskId: "task-cursor-no-auto",
			agentId: "cursor",
			binary: "cursor-agent",
			args: ["--force"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(cursorLaunch.args).toContain("--force");
	});
});

describe("toBracketedPasteSubmission", () => {
	it("wraps text in bracketed-paste markers and submits with a carriage return by default", () => {
		expect(toBracketedPasteSubmission("hello there")).toBe("[200~hello there[201~\r");
	});

	it("submits when submit is explicitly true", () => {
		expect(toBracketedPasteSubmission("do the thing", true)).toBe("[200~do the thing[201~\r");
	});

	it("stages text without a trailing carriage return when submit is false", () => {
		// --no-submit: the text is pasted into the prompt but NOT sent, so the
		// architect can stage multi-line steering before submitting.
		expect(toBracketedPasteSubmission("line one", false)).toBe("[200~line one[201~");
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

interface ClaudeHookSettings {
	hooks?: {
		PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
	};
}

function readClaudeSettings(): ClaudeHookSettings {
	const settingsPath = join(homedir(), ".cline", "kanban", "hooks", "claude", "settings.json");
	return JSON.parse(readFileSync(settingsPath, "utf8")) as ClaudeHookSettings;
}

function findBashGuardHook(
	settings: ClaudeHookSettings,
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
				startInPlanMode: true,
			});

			expect(launch.args).not.toContain("--permission-mode");
			expect(launch.args).not.toContain("plan");
			expect(launch.args).toContain("--dangerously-skip-permissions");
			expect(launch.args.at(-1)).toBe(`${PLAN_CARD_PROMPT_DIRECTIVE}Write the rollout design`);
			expect(launch.deferredStartupInput).toBeUndefined();
			expect(findBashGuardHook(readClaudeSettings())).toBeDefined();
		} finally {
			restoreProviderEnv();
		}
	});
});
