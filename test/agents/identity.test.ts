import { describe, expect, it } from "vitest";
import { createClaudeDriver } from "../../src/agents/claude/driver";
import { createCodexDriver } from "../../src/agents/codex/driver";
import { createGeminiDriver } from "../../src/agents/gemini/driver";
import { deriveHomeAgentClaudeSessionId } from "../../src/terminal/home-agent-session-id";
import type { DriverSessionRef, LaunchIdentityPlan } from "../../src/agents/driver";

describe("Agent Drivers Identity Resolution", () => {
	const claude = createClaudeDriver();
	const codex = createCodexDriver();
	const gemini = createGeminiDriver();

	const cardRef: DriverSessionRef = { kind: "card", taskId: "task-1" };
	const overseerRef: DriverSessionRef = { kind: "overseer", taskId: "home:workspace-1", workspaceId: "workspace-1" };

	describe("Claude Driver Identity", () => {
		// 1. First launch ever
		it("given first launch ever (stored: null, gone), resolves a card to a fresh minted UUID and overseer to derived ID", () => {
			const cardResult = claude.identity.resolve({
				ref: cardRef,
				stored: null,
				lifecycle: "gone",
				generation: 0,
			});
			expect(cardResult.supported).toBe(true);
			if (cardResult.supported) {
				expect(cardResult.value.agentSessionId).not.toBeNull();
				expect(cardResult.value.agentSessionId).toMatch(/^[a-f0-9-]{36}$/); // UUID format
				expect(cardResult.value.resumeSession).toBe(false);
				expect(cardResult.value.discoverAfterSpawn).toBe(false);
				expect(cardResult.value.durability).toBe("deterministic");
			}

			const overseerResult = claude.identity.resolve({
				ref: overseerRef,
				stored: null,
				lifecycle: "gone",
				generation: 2,
			});
			expect(overseerResult.supported).toBe(true);
			if (overseerResult.supported) {
				const expectedId = deriveHomeAgentClaudeSessionId("workspace-1", "claude", 2);
				expect(overseerResult.value.agentSessionId).toBe(expectedId);
				expect(overseerResult.value.resumeSession).toBe(false);
				expect(overseerResult.value.discoverAfterSpawn).toBe(false);
				expect(overseerResult.value.durability).toBe("deterministic");
			}
		});

		// 2. Resume of a resumable session
		it("given a resumable session (stored: present, resumable), resolves to the stored session ID (or derived for overseer) and resumes", () => {
			const cardResult = claude.identity.resolve({
				ref: cardRef,
				stored: "stored-card-session",
				lifecycle: "resumable",
				generation: 0,
			});
			expect(cardResult.supported).toBe(true);
			if (cardResult.supported) {
				expect(cardResult.value.agentSessionId).toBe("stored-card-session");
				expect(cardResult.value.resumeSession).toBe(true);
			}

			const overseerResult = claude.identity.resolve({
				ref: overseerRef,
				stored: "stored-overseer-session",
				lifecycle: "resumable",
				generation: 2,
			});
			expect(overseerResult.supported).toBe(true);
			if (overseerResult.supported) {
				const expectedId = deriveHomeAgentClaudeSessionId("workspace-1", "claude", 2);
				expect(overseerResult.value.agentSessionId).toBe(expectedId);
				expect(overseerResult.value.resumeSession).toBe(true);
			}
		});

		// 3. Session gone / worktree removed (lifecycle gone, stored present)
		it("given session gone or worktree removed (stored: present, gone), resolves card to a fresh minted UUID and overseer to derived ID", () => {
			const cardResult = claude.identity.resolve({
				ref: cardRef,
				stored: "stored-card-session",
				lifecycle: "gone",
				generation: 0,
			});
			expect(cardResult.supported).toBe(true);
			if (cardResult.supported) {
				expect(cardResult.value.agentSessionId).not.toBeNull();
				expect(cardResult.value.agentSessionId).not.toBe("stored-card-session");
				expect(cardResult.value.agentSessionId).toMatch(/^[a-f0-9-]{36}$/);
				expect(cardResult.value.resumeSession).toBe(false);
			}

			const overseerResult = claude.identity.resolve({
				ref: overseerRef,
				stored: "stored-overseer-session",
				lifecycle: "gone",
				generation: 2,
			});
			expect(overseerResult.supported).toBe(true);
			if (overseerResult.supported) {
				const expectedId = deriveHomeAgentClaudeSessionId("workspace-1", "claude", 2);
				expect(overseerResult.value.agentSessionId).toBe(expectedId);
				expect(overseerResult.value.resumeSession).toBe(false);
			}
		});
	});

	describe("Codex Driver Identity", () => {
		// 1. First launch ever
		it("given first launch ever (stored: null, gone), resolves both card and overseer to null ID and discoverAfterSpawn: true", () => {
			for (const ref of [cardRef, overseerRef]) {
				const result = codex.identity.resolve({
					ref,
					stored: null,
					lifecycle: "gone",
					generation: 0,
				});
				expect(result.supported).toBe(true);
				if (result.supported) {
					expect(result.value.agentSessionId).toBeNull();
					expect(result.value.resumeSession).toBe(false);
					expect(result.value.discoverAfterSpawn).toBe(true);
					expect(result.value.durability).toBe("persisted");
				}
			}
		});

		// 2. Resume of a resumable session
		it("given a resumable session (stored: present, resumable), resolves both to the stored session ID and resumes", () => {
			for (const ref of [cardRef, overseerRef]) {
				const result = codex.identity.resolve({
					ref,
					stored: "stored-session",
					lifecycle: "resumable",
					generation: 0,
				});
				expect(result.supported).toBe(true);
				if (result.supported) {
					expect(result.value.agentSessionId).toBe("stored-session");
					expect(result.value.resumeSession).toBe(true);
					expect(result.value.discoverAfterSpawn).toBe(true);
				}
			}
		});

		// 3. Session gone / worktree removed
		it("given session gone or worktree removed (stored: present, gone), resolves both to null ID and starts fresh", () => {
			for (const ref of [cardRef, overseerRef]) {
				const result = codex.identity.resolve({
					ref,
					stored: "stored-session",
					lifecycle: "gone",
					generation: 0,
				});
				expect(result.supported).toBe(true);
				if (result.supported) {
					expect(result.value.agentSessionId).toBeNull();
					expect(result.value.resumeSession).toBe(false);
					expect(result.value.discoverAfterSpawn).toBe(true);
				}
			}
		});
	});

	describe("Gemini Driver Identity", () => {
		// 1. First launch ever
		it("given first launch ever (stored: null, gone), resolves both card and overseer to null ID and discoverAfterSpawn: true", () => {
			for (const ref of [cardRef, overseerRef]) {
				const result = gemini.identity.resolve({
					ref,
					stored: null,
					lifecycle: "gone",
					generation: 0,
				});
				expect(result.supported).toBe(true);
				if (result.supported) {
					expect(result.value.agentSessionId).toBeNull();
					expect(result.value.resumeSession).toBe(false);
					expect(result.value.discoverAfterSpawn).toBe(true);
					expect(result.value.durability).toBe("persisted");
				}
			}
		});

		// 2. Resume of a resumable session
		it("given a resumable session (stored: present, resumable), resolves both to the stored session ID and resumes", () => {
			for (const ref of [cardRef, overseerRef]) {
				const result = gemini.identity.resolve({
					ref,
					stored: "stored-session",
					lifecycle: "resumable",
					generation: 0,
				});
				expect(result.supported).toBe(true);
				if (result.supported) {
					expect(result.value.agentSessionId).toBe("stored-session");
					expect(result.value.resumeSession).toBe(true);
					expect(result.value.discoverAfterSpawn).toBe(true);
				}
			}
		});

		// 3. Session gone / worktree removed
		it("given session gone or worktree removed (stored: present, gone), resolves both to null ID and starts fresh", () => {
			for (const ref of [cardRef, overseerRef]) {
				const result = gemini.identity.resolve({
					ref,
					stored: "stored-session",
					lifecycle: "gone",
					generation: 0,
				});
				expect(result.supported).toBe(true);
				if (result.supported) {
					expect(result.value.agentSessionId).toBeNull();
					expect(result.value.resumeSession).toBe(false);
					expect(result.value.discoverAfterSpawn).toBe(true);
				}
			}
		});
	});
});
