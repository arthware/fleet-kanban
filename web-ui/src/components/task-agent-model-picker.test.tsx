import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskAgentModelPicker, useTaskAgentModelPicker } from "@/components/task-agent-model-picker";
import type { RuntimeAgentId } from "@/runtime/types";

vi.mock("@runtime-agent-catalog", () => ({
	getRuntimeAgentCatalogEntry: vi.fn((agentId: RuntimeAgentId) => {
		const entries = {
			claude: { id: "claude", label: "Claude Code", supportsAgentModelOverride: true },
			codex: { id: "codex", label: "OpenAI Codex", supportsAgentModelOverride: false },
			gemini: { id: "gemini", label: "Gemini CLI", supportsAgentModelOverride: true },
		} satisfies Record<RuntimeAgentId, { id: RuntimeAgentId; label: string; supportsAgentModelOverride: boolean }>;
		return entries[agentId] ?? null;
	}),
	getRuntimeLaunchSupportedAgentCatalog: vi.fn(() => [
		{ id: "claude", label: "Claude Code" },
		{ id: "codex", label: "OpenAI Codex" },
		{ id: "gemini", label: "Gemini CLI" },
	]),
}));

function HookHarness({
	defaultAgentId,
	onOptions,
}: {
	defaultAgentId?: RuntimeAgentId | null;
	onOptions: (options: Array<{ value: string; label: string }>) => void;
}): null {
	const result = useTaskAgentModelPicker({
		active: true,
		workspaceId: null,
		agentId: undefined,
		defaultAgentId,
	});
	onOptions(result.agentOptions);
	return null;
}

describe("TaskAgentModelPicker", () => {
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
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("given a default agent, when options are built, then only supported harnesses are offered", () => {
		let options: Array<{ value: string; label: string }> = [];

		act(() => {
			root.render(<HookHarness defaultAgentId="claude" onOptions={(nextOptions) => (options = nextOptions)} />);
		});

		expect(options).toEqual([
			{ value: "", label: "Claude Code" },
			{ value: "codex", label: "OpenAI Codex" },
			{ value: "gemini", label: "Gemini CLI" },
		]);
	});

	it("given a selected agent that has no model override, when selected, then the stale model override is cleared", () => {
		const onAgentIdChange = vi.fn();
		const onAgentModelChange = vi.fn();

		act(() => {
			root.render(
				<TaskAgentModelPicker
					agentId={undefined}
					onAgentIdChange={onAgentIdChange}
					agentModel="claude-haiku-4-5"
					onAgentModelChange={onAgentModelChange}
					agentOptions={[
						{ value: "", label: "Claude Code" },
						{ value: "codex", label: "OpenAI Codex" },
					]}
					defaultAgentId="claude"
				/>,
			);
		});

		act(() => {
			container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		const select = container.querySelector("select");
		if (!(select instanceof HTMLSelectElement)) {
			throw new Error("Expected agent select.");
		}
		act(() => {
			select.value = "codex";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});

		expect(onAgentIdChange).toHaveBeenCalledWith("codex");
		expect(onAgentModelChange).toHaveBeenCalledWith(undefined);
	});
});
