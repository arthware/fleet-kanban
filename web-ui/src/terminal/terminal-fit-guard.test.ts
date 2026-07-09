import { describe, expect, it } from "vitest";

import { hasRenderableTerminalSize, shouldFitTerminalContainer } from "@/terminal/terminal-fit-guard";

describe("hasRenderableTerminalSize", () => {
	it("rejects a container with zero width", () => {
		expect(hasRenderableTerminalSize({ width: 0, height: 400 })).toBe(false);
	});

	it("rejects a container with zero height", () => {
		expect(hasRenderableTerminalSize({ width: 600, height: 0 })).toBe(false);
	});

	it("rejects a container with negative dimensions", () => {
		expect(hasRenderableTerminalSize({ width: -600, height: -400 })).toBe(false);
	});

	it("accepts a container with positive width and height", () => {
		expect(hasRenderableTerminalSize({ width: 600, height: 400 })).toBe(true);
	});
});

describe("shouldFitTerminalContainer", () => {
	it("fits the first time a renderable container is measured", () => {
		expect(shouldFitTerminalContainer({ width: 600, height: 400 }, null)).toBe(true);
	});

	it("never fits a zero-size container, breaking the resize feedback loop", () => {
		expect(shouldFitTerminalContainer({ width: 0, height: 0 }, null)).toBe(false);
		expect(shouldFitTerminalContainer({ width: 0, height: 0 }, { width: 600, height: 400 })).toBe(false);
	});

	it("skips fitting when the container size is unchanged since the last fit", () => {
		expect(shouldFitTerminalContainer({ width: 600, height: 400 }, { width: 600, height: 400 })).toBe(false);
	});

	it("fits again when the container size changes", () => {
		expect(shouldFitTerminalContainer({ width: 640, height: 400 }, { width: 600, height: 400 })).toBe(true);
		expect(shouldFitTerminalContainer({ width: 600, height: 420 }, { width: 600, height: 400 })).toBe(true);
	});
});
