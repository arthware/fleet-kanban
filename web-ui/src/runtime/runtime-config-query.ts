// Browser-side query helpers for runtime settings.
// Keep TRPC request details here so components and controller hooks can focus
// on state orchestration instead of transport plumbing.
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeAgentBudgetResponse,
	RuntimeAgentId,
	RuntimeConfigResponse,
	RuntimeDebugResetAllStateResponse,
	RuntimeFleetUpdateApplyResult,
	RuntimeFleetUpdateStatusResponse,
	RuntimeProjectShortcut,
	RuntimeRunUpdateResponse,
	RuntimeUpdateStatusResponse,
	RuntimeWorktreeConfig,
} from "@/runtime/types";

export async function fetchRuntimeConfig(workspaceId: string | null): Promise<RuntimeConfigResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.getConfig.query();
}

export async function saveRuntimeConfig(
	workspaceId: string | null,
	nextConfig: {
		selectedAgentId?: RuntimeAgentId;
		selectedShortcutLabel?: string | null;
		agentAutonomousModeEnabled?: boolean;
		shortcuts?: RuntimeProjectShortcut[];
		worktree?: RuntimeWorktreeConfig;
		readyForReviewNotificationsEnabled?: boolean;
	},
): Promise<RuntimeConfigResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.saveConfig.mutate(nextConfig);
}

export async function resetRuntimeDebugState(workspaceId: string | null): Promise<RuntimeDebugResetAllStateResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.resetAllState.mutate();
}

export async function openFileOnHost(workspaceId: string | null, filePath: string): Promise<void> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	await trpcClient.runtime.openFile.mutate({ filePath });
}

export async function fetchAgentBudget(workspaceId: string | null): Promise<RuntimeAgentBudgetResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.getAgentBudget.query();
}

export async function fetchRuntimeUpdateStatus(workspaceId: string | null): Promise<RuntimeUpdateStatusResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.getUpdateStatus.query();
}

export async function runRuntimeUpdateNow(workspaceId: string | null): Promise<RuntimeRunUpdateResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.runUpdateNow.mutate();
}

export async function fetchFleetUpdateStatus(workspaceId: string | null): Promise<RuntimeFleetUpdateStatusResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.getFleetUpdateStatus.query();
}

export async function applyFleetUpdate(workspaceId: string | null): Promise<RuntimeFleetUpdateApplyResult> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.applyFleetUpdate.mutate();
}
