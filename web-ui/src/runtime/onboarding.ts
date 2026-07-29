import type { RuntimeAgentId, RuntimeClineProviderSettings } from "@/runtime/types";

export function isSelectedAgentAuthenticated(
	selectedAgentId: RuntimeAgentId | null | undefined,
	clineProviderSettings: RuntimeClineProviderSettings | null | undefined,
): boolean {
	return true;
}

export function shouldShowStartupOnboardingDialog(input: { hasShownOnboardingDialog: boolean }): boolean {
	if (!input.hasShownOnboardingDialog) {
		return true;
	}
	return false;
}
