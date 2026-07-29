import * as Collapsible from "@radix-ui/react-collapsible";
import { getRuntimeAgentCatalogEntry, getRuntimeLaunchSupportedAgentCatalog } from "@runtime-agent-catalog";
import { ChevronDown } from "lucide-react";
import type { ReactElement } from "react";
import { useMemo, useState } from "react";

import { cn } from "@/components/ui/cn";
import { NativeSelect } from "@/components/ui/native-select";
import type { RuntimeAgentId } from "@/runtime/types";

export interface UseTaskAgentModelPickerInput {
	active: boolean;
	workspaceId: string | null;
	agentId: RuntimeAgentId | undefined;
	defaultAgentId?: RuntimeAgentId | null;
}

export interface UseTaskAgentModelPickerResult {
	agentOptions: Array<{ value: string; label: string }>;
}

export function useTaskAgentModelPicker({
	agentId: _agentId,
	defaultAgentId,
}: UseTaskAgentModelPickerInput): UseTaskAgentModelPickerResult {
	const agentOptions = useMemo(() => {
		const catalog = getRuntimeLaunchSupportedAgentCatalog();
		let firstLabel = "Default";
		if (defaultAgentId) {
			const defaultAgent = catalog.find((agent) => agent.id === defaultAgentId);
			if (defaultAgent) {
				firstLabel = defaultAgent.label;
			}
		}
		return [
			{ value: "", label: firstLabel },
			...catalog
				.filter((agent) => agent.id !== defaultAgentId)
				.map((agent) => ({ value: agent.id, label: agent.label })),
		];
	}, [defaultAgentId]);

	return { agentOptions };
}

export function TaskAgentModelPicker({
	agentId,
	onAgentIdChange,
	agentModel,
	onAgentModelChange,
	agentOptions,
	onPopoverOpenChange: _onPopoverOpenChange,
	defaultAgentId,
}: {
	agentId: RuntimeAgentId | undefined;
	onAgentIdChange: (value: RuntimeAgentId | undefined) => void;
	agentModel: string | undefined;
	onAgentModelChange: (value: string | undefined) => void;
	agentOptions: Array<{ value: string; label: string }>;
	onPopoverOpenChange?: (open: boolean) => void;
	defaultAgentId?: RuntimeAgentId | null;
}): ReactElement {
	const [isSettingsExpanded, setIsSettingsExpanded] = useState(false);
	const effectiveAgentId = agentId ?? defaultAgentId ?? null;

	return (
		<div className="flex flex-col gap-2">
			<Collapsible.Root open={isSettingsExpanded} onOpenChange={setIsSettingsExpanded}>
				<Collapsible.Trigger asChild>
					<button
						type="button"
						className="inline-flex w-fit items-center gap-1 text-[12px] text-text-secondary hover:text-text-primary cursor-pointer bg-transparent border-none p-0"
					>
						<ChevronDown
							size={12}
							className={cn("transition-transform", isSettingsExpanded ? "rotate-0" : "-rotate-90")}
						/>
						Override Agent Settings
					</button>
				</Collapsible.Trigger>
				<Collapsible.Content className="pt-2">
					<div className="flex flex-col gap-2">
						<div className="w-full sm:w-1/2 min-w-0">
							<span className="text-[11px] text-text-secondary block mb-1">Agent</span>
							<NativeSelect
								size="sm"
								fill
								value={agentId ?? ""}
								onChange={(event) => {
									const value = event.currentTarget.value;
									const nextAgentId = value ? (value as RuntimeAgentId) : undefined;
									onAgentIdChange(nextAgentId);
									if (
										!getRuntimeAgentCatalogEntry(nextAgentId ?? defaultAgentId ?? "claude")
											?.supportsAgentModelOverride
									) {
										onAgentModelChange(undefined);
									}
								}}
							>
								{agentOptions.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</NativeSelect>
						</div>
						{effectiveAgentId && getRuntimeAgentCatalogEntry(effectiveAgentId)?.supportsAgentModelOverride ? (
							<div className="w-full sm:w-1/2 min-w-0">
								<span className="text-[11px] text-text-secondary block mb-1">Model</span>
								<input
									type="text"
									value={agentModel ?? ""}
									onChange={(event) =>
										onAgentModelChange(event.target.value.trim() ? event.target.value : undefined)
									}
									placeholder="e.g. claude-haiku-4-5"
									className="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
								/>
							</div>
						) : null}
					</div>
				</Collapsible.Content>
			</Collapsible.Root>
		</div>
	);
}
