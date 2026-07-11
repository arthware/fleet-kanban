import { describe, expect, it } from "vitest";

import {
	isAutoModeCapableModel,
	isClaudeCloudProviderBackend,
	resolveClaudePermissionStrategy,
} from "../../../src/terminal/claude-permission-strategy";

describe("isAutoModeCapableModel", () => {
	it("treats an unset model (workspace default) as capable", () => {
		expect(isAutoModeCapableModel(undefined)).toBe(true);
		expect(isAutoModeCapableModel("")).toBe(true);
		expect(isAutoModeCapableModel("   ")).toBe(true);
	});

	it("classifies Opus and Sonnet as capable", () => {
		expect(isAutoModeCapableModel("claude-opus-4-8")).toBe(true);
		expect(isAutoModeCapableModel("claude-sonnet-4-6")).toBe(true);
		expect(isAutoModeCapableModel("opus")).toBe(true);
		expect(isAutoModeCapableModel("Claude-Sonnet-4-20250514")).toBe(true);
	});

	it("classifies Haiku and unknown/cheap tiers as not capable", () => {
		expect(isAutoModeCapableModel("claude-haiku-4-5")).toBe(false);
		expect(isAutoModeCapableModel("claude-3-5-haiku-20241022")).toBe(false);
		expect(isAutoModeCapableModel("some-mini-model")).toBe(false);
		expect(isAutoModeCapableModel("gpt-fast")).toBe(false);
	});
});

describe("isClaudeCloudProviderBackend", () => {
	it("detects Bedrock / Vertex / Foundry toggle env vars", () => {
		expect(isClaudeCloudProviderBackend({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe(true);
		expect(isClaudeCloudProviderBackend({ CLAUDE_CODE_USE_VERTEX: "true" })).toBe(true);
		expect(isClaudeCloudProviderBackend({ CLAUDE_CODE_USE_FOUNDRY: "yes" })).toBe(true);
	});

	it("treats the direct Anthropic API (no toggle) as not a cloud backend", () => {
		expect(isClaudeCloudProviderBackend({})).toBe(false);
		expect(isClaudeCloudProviderBackend({ CLAUDE_CODE_USE_BEDROCK: "0" })).toBe(false);
		expect(isClaudeCloudProviderBackend({ CLAUDE_CODE_USE_VERTEX: "false" })).toBe(false);
		expect(isClaudeCloudProviderBackend({ CLAUDE_CODE_USE_FOUNDRY: "" })).toBe(false);
	});
});

describe("resolveClaudePermissionStrategy", () => {
	it("keeps auto mode for capable models on the Anthropic API (no #532 regression)", () => {
		expect(resolveClaudePermissionStrategy({ agentModel: "claude-opus-4-8", cloudProviderBackend: false })).toBe(
			"auto",
		);
		expect(resolveClaudePermissionStrategy({ agentModel: undefined, cloudProviderBackend: false })).toBe("auto");
		expect(resolveClaudePermissionStrategy({ agentModel: "claude-sonnet-4-6", cloudProviderBackend: false })).toBe(
			"auto",
		);
	});

	it("uses the guarded bypass for weak/unknown models on the Anthropic API", () => {
		expect(resolveClaudePermissionStrategy({ agentModel: "claude-haiku-4-5", cloudProviderBackend: false })).toBe(
			"bypass-guarded",
		);
		expect(resolveClaudePermissionStrategy({ agentModel: "mystery-mini", cloudProviderBackend: false })).toBe(
			"bypass-guarded",
		);
	});

	it("keeps auto mode on a cloud-provider backend regardless of tier", () => {
		expect(resolveClaudePermissionStrategy({ agentModel: "claude-haiku-4-5", cloudProviderBackend: true })).toBe(
			"auto",
		);
		expect(resolveClaudePermissionStrategy({ agentModel: "mystery-mini", cloudProviderBackend: true })).toBe("auto");
	});
});
