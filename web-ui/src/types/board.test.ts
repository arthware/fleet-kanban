import { describe, expect, it } from "vitest";

import { getTaskAutoReviewActionLabel, getTaskAutoReviewCancelButtonLabel } from "@/types";

describe("getTaskAutoReviewActionLabel", () => {
	it("returns the expected label for each auto review mode", () => {
		expect(getTaskAutoReviewActionLabel("pr")).toBe("PR");
	});

	it("falls back to manual review when the mode is missing", () => {
		expect(getTaskAutoReviewActionLabel(undefined)).toBe("manual review");
	});

	it("returns the expected cancel button label for each auto review mode", () => {
		expect(getTaskAutoReviewCancelButtonLabel("pr")).toBe("Cancel Auto-PR");
	});
});
