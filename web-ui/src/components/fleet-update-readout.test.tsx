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
}): void {
	useFleetUpdateStatusMock.mockReturnValue({
		status: overrides.status ?? null,
		phase: overrides.phase ?? "idle",
		apply: overrides.apply ?? vi.fn(),
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

	it("given an update is available and no cards are in progress, when rendered, then it shows an enabled pill", () => {
		mockHook({
			status: {
				status: { mode: "vendor", current: "abc1234", latest: "def5678", updateAvailable: true },
				inProgressCount: 0,
			},
		});

		act(() => {
			root.render(<FleetUpdateReadout />);
		});

		const button = container.querySelector('button[aria-label="Apply fleet update"]');
		expect(button).not.toBeNull();
		expect(button?.hasAttribute("disabled")).toBe(false);
	});

	it("given an update is available, when the pill is clicked, then it calls apply()", () => {
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

		const button = container.querySelector('button[aria-label="Apply fleet update"]') as HTMLButtonElement;
		act(() => {
			button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		});

		expect(apply).toHaveBeenCalledTimes(1);
	});

	it("given an update is available but cards are in progress, when rendered, then the pill is disabled with an explanatory title", () => {
		mockHook({
			status: {
				status: { mode: "vendor", current: "abc1234", latest: "def5678", updateAvailable: true },
				inProgressCount: 2,
			},
		});

		act(() => {
			root.render(<FleetUpdateReadout />);
		});

		const button = container.querySelector('button[aria-label="Apply fleet update"]');
		expect(button?.hasAttribute("disabled")).toBe(true);
		expect(button?.getAttribute("title")).toContain("2 cards in progress");
	});

	it("given the update is applying, when rendered, then it shows an updating indicator instead of the pill", () => {
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
		expect(container.querySelector('button[aria-label="Apply fleet update"]')).toBeNull();
	});

	it("given the board is restarting, when rendered, then it shows an updating indicator", () => {
		mockHook({ status: null, phase: "restarting" });

		act(() => {
			root.render(<FleetUpdateReadout />);
		});

		expect(container.querySelector('[data-testid="fleet-update-readout-updating"]')).not.toBeNull();
	});

	it("given the restart timed out, when rendered, then it shows a timed-out message", () => {
		mockHook({ status: null, phase: "restart-timed-out" });

		act(() => {
			root.render(<FleetUpdateReadout />);
		});

		expect(container.querySelector('[data-testid="fleet-update-readout-timed-out"]')).not.toBeNull();
	});
});
