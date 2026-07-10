import { describe, expect, inject, it } from "vitest";

describe("shared kanban test instance", () => {
	it("boots once for the whole run and answers on its injected base url", async () => {
		const baseUrl = inject("kanbanBaseUrl");
		expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);

		const response = await fetch(`${baseUrl}/api/trpc/projects.list`);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toHaveProperty("result");
	});

	it("exposes its port to tests via inject", () => {
		const port = inject("kanbanPort");
		expect(port).toBeGreaterThan(0);
	});
});
