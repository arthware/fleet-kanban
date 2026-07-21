import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskStartAgentOnboardingCarousel } from "@/components/task-start-agent-onboarding-carousel";
import type { RuntimeAgentDefinition, RuntimeConfigResponse } from "@/runtime/types";

vi.mock("@runtime-agent-catalog", () => ({
	getRuntimeAgentCatalogEntry: vi.fn((agentId: string) => {
		const entries: Record<string, { id: string; label: string; installUrl: string | null }> = {
			cline: { id: "cline", label: "Cline", installUrl: null },
			claude: { id: "claude", label: "Claude Code", installUrl: "https://docs.anthropic.com" },
			cursor: { id: "cursor", label: "Cursor Agent", installUrl: "https://cursor.com/docs/cli/overview" },
			codex: { id: "codex", label: "OpenAI Codex", installUrl: "https://github.com/openai/codex" },
			droid: { id: "droid", label: "Factory Droid", installUrl: "https://docs.factory.ai" },
			kiro: { id: "kiro", label: "Kiro", installUrl: "https://kiro.dev" },
		};
		return entries[agentId] ?? null;
	}),
}));

vi.mock("@/components/shared/cline-setup-section", () => ({
	ClineSetupSection: () => null,
}));

vi.mock("@/hooks/use-runtime-settings-cline-controller", () => ({
	useRuntimeSettingsClineController: () => ({
		hasUnsavedChanges: false,
		saveProviderSettings: vi.fn(async () => ({ ok: true })),
	}),
}));

vi.mock("@/runtime/native-agent", () => ({
	isClineProviderAuthenticated: () => false,
}));

const baseRuntimeConfig = {
	selectedAgentId: "cline",
	selectedShortcutLabel: null,
	agentAutonomousModeEnabled: true,
	readyForReviewNotificationsEnabled: true,
	effectiveCommand: null,
	detectedCommands: [],
	shortcuts: [],
	globalConfigPath: null,
	projectConfigPath: null,
	agents: [],
	clineProviderSettings: null,
} as unknown as RuntimeConfigResponse;

const registeredAgents: RuntimeAgentDefinition[] = [
	{
		id: "cline",
		label: "Cline",
		binary: "cline",
		command: "cline",
		defaultArgs: [],
		installed: true,
		configured: true,
	},
	{
		id: "claude",
		label: "Claude Code",
		binary: "claude",
		command: "claude",
		defaultArgs: [],
		installed: true,
		configured: false,
	},
	{
		id: "cursor",
		label: "Cursor Agent",
		binary: "cursor-agent",
		command: "cursor-agent",
		defaultArgs: [],
		installed: true,
		configured: false,
	},
	{
		id: "codex",
		label: "OpenAI Codex",
		binary: "codex",
		command: "codex",
		defaultArgs: [],
		installed: false,
		configured: false,
	},
	{
		id: "droid",
		label: "Factory Droid",
		binary: "droid",
		command: "droid",
		defaultArgs: [],
		installed: false,
		configured: false,
	},
	{
		id: "kiro",
		label: "Kiro",
		binary: "kiro-cli",
		command: "kiro-cli chat",
		defaultArgs: ["chat"],
		installed: false,
		configured: false,
	},
];

describe("TaskStartAgentOnboardingCarousel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		document.body.innerHTML = "";
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("given Cursor is registered, when onboarding renders the agent step, then Cursor Agent appears", async () => {
		// given
		const agents = registeredAgents;

		// when
		await act(async () => {
			root.render(
				<TaskStartAgentOnboardingCarousel
					open={true}
					workspaceId={"workspace-1"}
					runtimeConfig={baseRuntimeConfig}
					selectedAgentId={"cline"}
					agents={agents}
					clineProviderSettings={null}
					activeSlideIndex={3}
				/>,
			);
		});

		// then
		expect(document.body.textContent).toContain("Cursor Agent");
		expect(document.body.textContent).toContain("Cursor's coding agent CLI powered by Cursor Agent.");
	});
});
