import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PrBadge } from "@/components/pr-badge";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	root.unmount();
	container.remove();
});

describe("PrBadge", () => {
	it("given a card with prState closed, when PrBadge renders, then the label has line-through", async () => {
		await act(async () => {
			root.render(
				<PrBadge
					card={{
						prUrl: "https://github.com/cline/kanban/pull/42",
						prState: "closed",
						prNumber: 42,
					}}
				/>,
			);
		});

		const label = container.querySelector("span");
		expect(label?.textContent).toBe("PR #42");
		expect(label?.className).toContain("line-through");
	});

	it("given a card with prState merged, when PrBadge renders, then the label does not have line-through", async () => {
		await act(async () => {
			root.render(
				<PrBadge
					card={{
						prUrl: "https://github.com/cline/kanban/pull/42",
						prState: "merged",
						prNumber: 42,
					}}
				/>,
			);
		});

		const label = container.querySelector("span");
		expect(label?.textContent).toBe("PR #42");
		expect(label?.className).not.toContain("line-through");
	});

	it("given an open PR with passing gate, when PrBadge renders, then it renders a green check icon", async () => {
		await act(async () => {
			root.render(
				<PrBadge
					card={{
						prUrl: "https://github.com/cline/kanban/pull/42",
						prState: "open",
						prNumber: 42,
						prGateStatus: "passing",
					}}
				/>,
			);
		});

		const checkIcon = container.querySelector("svg.text-status-green");
		expect(checkIcon).not.toBeNull();
	});

	it("given an open PR with failing gate, when PrBadge renders, then it renders a red X/failing icon", async () => {
		await act(async () => {
			root.render(
				<PrBadge
					card={{
						prUrl: "https://github.com/cline/kanban/pull/42",
						prState: "open",
						prNumber: 42,
						prGateStatus: "failing",
					}}
				/>,
			);
		});

		const failIcon = container.querySelector("svg.text-status-red");
		expect(failIcon).not.toBeNull();
	});

	it("given an open PR with pending gate, when PrBadge renders, then it renders an orange spinner", async () => {
		await act(async () => {
			root.render(
				<PrBadge
					card={{
						prUrl: "https://github.com/cline/kanban/pull/42",
						prState: "open",
						prNumber: 42,
						prGateStatus: "pending",
					}}
				/>,
			);
		});

		const pendingIcon = container.querySelector("svg.text-status-orange.animate-spin");
		expect(pendingIcon).not.toBeNull();
	});

	it("given an open PR with gate status none, when PrBadge renders, then it does not render a gate status icon", async () => {
		await act(async () => {
			root.render(
				<PrBadge
					card={{
						prUrl: "https://github.com/cline/kanban/pull/42",
						prState: "open",
						prNumber: 42,
						prGateStatus: "none",
					}}
				/>,
			);
		});

		const gateIcon = container.querySelector("svg.text-status-green, svg.text-status-red, svg.text-status-orange");
		expect(gateIcon).toBeNull();
	});
});
