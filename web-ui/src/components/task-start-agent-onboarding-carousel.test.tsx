import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskStartAgentOnboardingCarousel } from "@/components/task-start-agent-onboarding-carousel";
import type { RuntimeAgentDefinition, RuntimeConfigResponse } from "@/runtime/types";

vi.mock("@runtime-agent-catalog", () => ({
	getRuntimeAgentCatalogEntry: vi.fn((agentId: string) => {
		const entries: Record<string, { id: string; label: string; installUrl: string | null }> = {
			claude: { id: "claude", label: "Claude Code", installUrl: "https://docs.anthropic.com" },
			codex: { id: "codex", label: "OpenAI Codex", installUrl: "https://github.com/openai/codex" },
			gemini: { id: "gemini", label: "Gemini CLI", installUrl: "https://github.com/google-gemini/gemini-cli" },
		};
		return entries[agentId] ?? null;
	}),
}));

const baseRuntimeConfig = {
	selectedAgentId: "claude",
	selectedShortcutLabel: null,
	agentAutonomousModeEnabled: true,
	readyForReviewNotificationsEnabled: true,
	effectiveCommand: null,
	detectedCommands: [],
	shortcuts: [],
	globalConfigPath: null,
	projectConfigPath: null,
	agents: [],
} as unknown as RuntimeConfigResponse;

const registeredAgents: RuntimeAgentDefinition[] = [
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
		id: "codex",
		label: "OpenAI Codex",
		binary: "codex",
		command: "codex",
		defaultArgs: [],
		installed: false,
		configured: false,
	},
	{
		id: "gemini",
		label: "Gemini CLI",
		binary: "gemini",
		command: "gemini",
		defaultArgs: [],
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

	it("given only supported agents are registered, when onboarding renders the agent step, then no retired harness appears", async () => {
		// given
		const agents = registeredAgents;

		// when
		await act(async () => {
			root.render(
				<TaskStartAgentOnboardingCarousel
					open={true}
					workspaceId={"workspace-1"}
					runtimeConfig={baseRuntimeConfig}
					selectedAgentId={"claude"}
					agents={agents}
					activeSlideIndex={3}
				/>,
			);
		});

		// then
		expect(document.body.textContent).toContain("Claude Code");
		expect(document.body.textContent).toContain("OpenAI Codex");
		expect(document.body.textContent).toContain("Gemini CLI");
		expect(document.body.textContent).not.toContain("Cline");
		expect(document.body.textContent).not.toContain("Cursor Agent");
		expect(document.body.textContent).not.toContain("Factory Droid");
		expect(document.body.textContent).not.toContain("Kiro");
	});
});
