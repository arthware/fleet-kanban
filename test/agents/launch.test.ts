import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClaudeDriver } from "../../src/agents/claude/driver";
import { createCodexDriver } from "../../src/agents/codex/driver";
import type { LaunchRequest } from "../../src/agents/driver";
import { createGeminiDriver } from "../../src/agents/gemini/driver";

describe("Agent Drivers Launch Port Conformance", () => {
	const claude = createClaudeDriver();
	const codex = createCodexDriver();
	const gemini = createGeminiDriver();

	const drivers = [claude, codex, gemini];

	beforeEach(() => {
		delete process.env.KANBAN_TEST_PREFLIGHT_FAIL;
	});

	afterEach(() => {
		delete process.env.KANBAN_TEST_PREFLIGHT_FAIL;
	});

	describe("preflight refusal", () => {
		it("should refuse preflight with a reason when forced", async () => {
			for (const driver of drivers) {
				process.env.KANBAN_TEST_PREFLIGHT_FAIL = `forced failure for ${driver.id}`;
				const preflightResult = await driver.launch.preflight();
				expect(preflightResult.supported).toBe(false);
				if (!preflightResult.supported) {
					expect(preflightResult.reason).toBe(`forced failure for ${driver.id}`);
				}
			}
		});
	});

	describe("Claude Driver Launch", () => {
		const baseRequest: LaunchRequest = {
			taskId: "task-123",
			prompt: "hello claude",
			cwd: "/workspace/path",
			env: {},
			args: [],
			autonomousModeEnabled: false,
			agentSessionId: "session-abc",
			resumeSession: false,
			resumeFromTrash: false,
			agentModel: null,
			workspaceId: null,
			architectContextPreamble: null,
		};

		it("prepares a fresh start correctly", async () => {
			const planResult = await claude.launch.prepare({
				...baseRequest,
				agentSessionId: "session-abc",
				resumeSession: false,
			});
			expect(planResult.supported).toBe(true);
			if (planResult.supported) {
				expect(planResult.value.args).toContain("session-abc");
				expect(planResult.value.args).toContain("--session-id");
				expect(planResult.value.args).toContain("hello claude");
			}
		});

		it("prepares a resume correctly", async () => {
			const planResult = await claude.launch.prepare({
				...baseRequest,
				agentSessionId: "session-abc",
				resumeSession: true,
			});
			expect(planResult.supported).toBe(true);
			if (planResult.supported) {
				expect(planResult.value.args).toContain("session-abc");
				expect(planResult.value.args).toContain("--resume");
				expect(planResult.value.args).not.toContain("--session-id");
			}
		});

		it("applies model override when provided", async () => {
			const planResult = await claude.launch.prepare({
				...baseRequest,
				agentModel: "sonnet-3-5",
			});
			expect(planResult.supported).toBe(true);
			if (planResult.supported) {
				expect(planResult.value.args).toContain("sonnet-3-5");
				expect(planResult.value.args).toContain("--model");
			}
		});

		it("lets user-supplied model win over card's override", async () => {
			const planResult = await claude.launch.prepare({
				...baseRequest,
				args: ["--model", "user-opus"],
				agentModel: "sonnet-3-5",
			});
			expect(planResult.supported).toBe(true);
			if (planResult.supported) {
				expect(planResult.value.args).toContain("user-opus");
				expect(planResult.value.args).not.toContain("sonnet-3-5");
			}
		});
	});

	describe("Codex Driver Launch", () => {
		const baseRequest: LaunchRequest = {
			taskId: "task-123",
			prompt: "hello codex",
			cwd: "/workspace/path",
			env: {},
			args: [],
			autonomousModeEnabled: false,
			agentSessionId: "session-xyz",
			resumeSession: false,
			resumeFromTrash: false,
			agentModel: null,
			workspaceId: null,
			architectContextPreamble: null,
		};

		it("prepares a fresh start correctly", async () => {
			const planResult = await codex.launch.prepare({
				...baseRequest,
			});
			expect(planResult.supported).toBe(true);
			if (planResult.supported) {
				expect(planResult.value.args).toContain("hello codex");
				expect(planResult.value.args).not.toContain("resume");
			}
		});

		it("prepares a resume correctly", async () => {
			const planResult = await codex.launch.prepare({
				...baseRequest,
				resumeSession: true,
			});
			expect(planResult.supported).toBe(true);
			if (planResult.supported) {
				expect(planResult.value.args).toContain("resume");
				expect(planResult.value.args).toContain("session-xyz");
			}
		});

		it("applies model override when provided", async () => {
			const planResult = await codex.launch.prepare({
				...baseRequest,
				agentModel: "gpt-4-turbo",
			});
			expect(planResult.supported).toBe(true);
			if (planResult.supported) {
				expect(planResult.value.args).toContain("gpt-4-turbo");
				expect(planResult.value.args).toContain("--model");
			}
		});

		it("lets user-supplied model win over card's override", async () => {
			const planResult = await codex.launch.prepare({
				...baseRequest,
				args: ["--model", "user-model"],
				agentModel: "gpt-4-turbo",
			});
			expect(planResult.supported).toBe(true);
			if (planResult.supported) {
				expect(planResult.value.args).toContain("user-model");
				expect(planResult.value.args).not.toContain("gpt-4-turbo");
			}
		});
	});

	describe("Gemini Driver Launch", () => {
		const baseRequest: LaunchRequest = {
			taskId: "task-123",
			prompt: "hello gemini",
			cwd: "/workspace/path",
			env: {},
			args: [],
			autonomousModeEnabled: false,
			agentSessionId: "session-gem",
			resumeSession: false,
			resumeFromTrash: false,
			agentModel: null,
			workspaceId: null,
			architectContextPreamble: null,
		};

		it("prepares a fresh start correctly", async () => {
			const planResult = await gemini.launch.prepare({
				...baseRequest,
			});
			expect(planResult.supported).toBe(true);
			if (planResult.supported) {
				expect(planResult.value.args).toContain("hello gemini");
				expect(planResult.value.args).toContain("-i");
				expect(planResult.value.args).not.toContain("--resume");
			}
		});

		it("prepares a resume correctly", async () => {
			const planResult = await gemini.launch.prepare({
				...baseRequest,
				resumeSession: true,
			});
			expect(planResult.supported).toBe(true);
			if (planResult.supported) {
				expect(planResult.value.args).toContain("--resume");
				expect(planResult.value.args).toContain("session-gem");
			}
		});

		it("applies model override when provided", async () => {
			const planResult = await gemini.launch.prepare({
				...baseRequest,
				agentModel: "gemini-1.5-pro",
			});
			expect(planResult.supported).toBe(true);
			if (planResult.supported) {
				expect(planResult.value.args).toContain("gemini-1.5-pro");
				expect(planResult.value.args).toContain("--model");
			}
		});

		it("lets user-supplied model win over card's override", async () => {
			const planResult = await gemini.launch.prepare({
				...baseRequest,
				args: ["--model", "user-gemini"],
				agentModel: "gemini-1.5-pro",
			});
			expect(planResult.supported).toBe(true);
			if (planResult.supported) {
				expect(planResult.value.args).toContain("user-gemini");
				expect(planResult.value.args).not.toContain("gemini-1.5-pro");
			}
		});
	});
});
