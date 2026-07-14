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
});
