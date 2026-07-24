import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetUpdatePhase } from "@/hooks/use-fleet-update-status";
import type { RuntimeFleetUpdateStatusResponse } from "@/runtime/types";

const useFleetUpdateStatusMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-fleet-update-status", () => ({
	useFleetUpdateStatus: useFleetUpdateStatusMock,
}));

import { FleetUpdateReadout } from "@/components/fleet-update-readout";

function mockHook(overrides: {
	status?: RuntimeFleetUpdateStatusResponse | null;
	phase?: FleetUpdatePhase;
	apply?: () => void;
	lastCheckedAt?: number | null;
}): void {
	useFleetUpdateStatusMock.mockReturnValue({
		status: overrides.status ?? null,
		phase: overrides.phase ?? "idle",
		apply: overrides.apply ?? vi.fn(),
		lastCheckedAt: overrides.lastCheckedAt ?? null,
	});
}

describe("FleetUpdateReadout", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		useFleetUpdateStatusMock.mockReset();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	// Radix Popover renders its content into a portal on document.body.
	function q(selector: string): Element | null {
		return document.body.querySelector(selector);
	}

	function openPopover(triggerLabel: string): void {
		const trigger = q(`button[aria-label="${triggerLabel}"]`) as HTMLButtonElement;
		act(() => {
			trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		});
	}

	it("given no status has loaded yet, when rendered, then it renders nothing", () => {
		mockHook({ status: null });

		act(() => {
			root.render(<FleetUpdateReadout />);
		});

		expect(container.textContent).toBe("");
	});

	it("given a source-mode board, when rendered, then it renders nothing", () => {
		mockHook({
			status: {
				status: { mode: "source", current: null, latest: null, updateAvailable: false },
				inProgressCount: 0,
			},
		});

		act(() => {
			root.render(<FleetUpdateReadout />);
		});

		expect(container.textContent).toBe("");
	});

	it("given a vendor board that is already up to date, when rendered, then it renders nothing", () => {
		mockHook({
			status: {
				status: { mode: "vendor", current: "abc1234", latest: "abc1234", updateAvailable: false },
				inProgressCount: 0,
			},
		});

		act(() => {
			root.render(<FleetUpdateReadout />);
		});

		expect(container.textContent).toBe("");
	});

	it("given an update is available, when rendered, then it shows only a compact icon and no text button", () => {
		mockHook({
			status: {
				status: { mode: "vendor", current: "abc1234", latest: "def5678", updateAvailable: true },
				inProgressCount: 0,
			},
		});

		act(() => {
			root.render(<FleetUpdateReadout />);
		});

		const trigger = container.querySelector('button[aria-label="Fleet update available"]');
		expect(trigger).not.toBeNull();
		expect(container.textContent).not.toContain("Update available");
	});

	it("given an update is available, when the icon is clicked, then the popover shows the current and latest short SHAs and a checked time", () => {
		mockHook({
			status: {
				status: { mode: "vendor", current: "abc1234def", latest: "def5678abc", updateAvailable: true },
				inProgressCount: 0,
			},
			lastCheckedAt: Date.now(),
		});

		act(() => {
			root.render(<FleetUpdateReadout />);
		});
		openPopover("Fleet update available");

		expect(document.body.textContent).toContain("abc1234");
		expect(document.body.textContent).toContain("def5678");
		expect(document.body.textContent).toContain("checked");
	});

	it("given an update is available and no cards are in progress, when the icon is clicked, then the popover's Update button is enabled", () => {
		mockHook({
			status: {
				status: { mode: "vendor", current: "abc1234", latest: "def5678", updateAvailable: true },
				inProgressCount: 0,
			},
		});

		act(() => {
			root.render(<FleetUpdateReadout />);
		});
		openPopover("Fleet update available");

		const applyButton = q('button[aria-label="Apply fleet update"]');
		expect(applyButton).not.toBeNull();
		expect(applyButton?.hasAttribute("disabled")).toBe(false);
	});

	it("given the popover is open, when the Update button is clicked, then it calls apply()", () => {
		const apply = vi.fn();
		mockHook({
			status: {
				status: { mode: "vendor", current: "abc1234", latest: "def5678", updateAvailable: true },
				inProgressCount: 0,
			},
			apply,
		});

		act(() => {
			root.render(<FleetUpdateReadout />);
		});
		openPopover("Fleet update available");

		const applyButton = q('button[aria-label="Apply fleet update"]') as HTMLButtonElement;
		act(() => {
			applyButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		});

		expect(apply).toHaveBeenCalledTimes(1);
	});

	it("given an update is available but cards are in progress, when the icon is clicked, then the popover's Update button is disabled and shows the reason", () => {
		mockHook({
			status: {
				status: { mode: "vendor", current: "abc1234", latest: "def5678", updateAvailable: true },
				inProgressCount: 2,
			},
		});

		act(() => {
			root.render(<FleetUpdateReadout />);
		});
		openPopover("Fleet update available");

		const applyButton = q('button[aria-label="Apply fleet update"]');
		expect(applyButton?.hasAttribute("disabled")).toBe(true);
		expect(document.body.textContent).toContain("2 cards in progress");
	});

	it("given the update is applying, when rendered, then it shows an updating indicator instead of the available icon", () => {
		mockHook({
			status: {
				status: { mode: "vendor", current: "abc1234", latest: "def5678", updateAvailable: true },
				inProgressCount: 0,
			},
			phase: "applying",
		});

		act(() => {
			root.render(<FleetUpdateReadout />);
		});

		expect(container.querySelector('[data-testid="fleet-update-readout-updating"]')).not.toBeNull();
		expect(container.querySelector('button[aria-label="Fleet update available"]')).toBeNull();
	});

	it("given the board is restarting, when rendered, then it shows an updating indicator", () => {
		mockHook({ status: null, phase: "restarting" });

		act(() => {
			root.render(<FleetUpdateReadout />);
		});

		expect(container.querySelector('[data-testid="fleet-update-readout-updating"]')).not.toBeNull();
	});

	it("given the restart timed out, when rendered, then it shows a timed-out indicator", () => {
		mockHook({ status: null, phase: "restart-timed-out" });

		act(() => {
			root.render(<FleetUpdateReadout />);
		});

		expect(container.querySelector('[data-testid="fleet-update-readout-timed-out"]')).not.toBeNull();
	});

	it("given the restart timed out, when the indicator is clicked, then the popover explains it and hints at a manual reload", () => {
		mockHook({ status: null, phase: "restart-timed-out" });

		act(() => {
			root.render(<FleetUpdateReadout />);
		});
		openPopover("Fleet update status");

		expect(document.body.textContent).toContain("restarting");
		expect(document.body.textContent.toLowerCase()).toContain("reload");
	});
});
