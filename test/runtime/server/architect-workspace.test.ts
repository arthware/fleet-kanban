import { describe, expect, it } from "vitest";

import {
	buildArchitectContextPreamble,
	classifyArchitectWorkspace,
	resolveAgentConfigRoot,
	resolveHomeAgentContext,
	resolveHomeAgentCwd,
} from "../../../src/server/architect-workspace";

describe("classifyArchitectWorkspace", () => {
	it("reports no architect when every workspace is a flat peer", () => {
		const classification = classifyArchitectWorkspace([
			{ workspaceId: "repo1", repoPath: "/home/user/code/repo1" },
			{ workspaceId: "repo2", repoPath: "/home/user/code/repo2" },
		]);

		expect(classification).toEqual({
			architectWorkspaceId: null,
			implWorkspaceIds: [],
		});
	});

	it("names the parent as architect when it contains one child repo", () => {
		const classification = classifyArchitectWorkspace([
			{ workspaceId: "tools", repoPath: "/home/user/code/tools" },
			{ workspaceId: "fleet-kanban", repoPath: "/home/user/code/tools/fleet-kanban" },
		]);

		expect(classification).toEqual({
			architectWorkspaceId: "tools",
			implWorkspaceIds: ["fleet-kanban"],
		});
	});

	it("collects every contained repo as an impl under a multi-child architect", () => {
		const classification = classifyArchitectWorkspace([
			{ workspaceId: "tools", repoPath: "/home/user/code/tools" },
			{ workspaceId: "kanban", repoPath: "/home/user/code/tools/kanban" },
			{ workspaceId: "fleet", repoPath: "/home/user/code/tools/fleet" },
		]);

		expect(classification.architectWorkspaceId).toBe("tools");
		expect([...classification.implWorkspaceIds].sort()).toEqual(["fleet", "kanban"]);
	});

	it("elects the outermost container as architect when repos nest three deep", () => {
		const classification = classifyArchitectWorkspace([
			{ workspaceId: "top", repoPath: "/a" },
			{ workspaceId: "middle", repoPath: "/a/b" },
			{ workspaceId: "leaf", repoPath: "/a/b/c" },
		]);

		expect(classification.architectWorkspaceId).toBe("top");
		expect([...classification.implWorkspaceIds].sort()).toEqual(["leaf", "middle"]);
	});

	it("does not treat a sibling sharing a name prefix as contained (tools vs tools-x)", () => {
		const classification = classifyArchitectWorkspace([
			{ workspaceId: "tools", repoPath: "/home/user/tools" },
			{ workspaceId: "tools-x", repoPath: "/home/user/tools-x" },
		]);

		expect(classification).toEqual({
			architectWorkspaceId: null,
			implWorkspaceIds: [],
		});
	});
});

describe("resolveAgentConfigRoot", () => {
	const workspaces = [
		{ workspaceId: "tools", repoPath: "/home/user/code/tools" },
		{ workspaceId: "fleet-kanban", repoPath: "/home/user/code/tools/fleet-kanban" },
	];
	const classification = classifyArchitectWorkspace(workspaces);

	it("roots the architect agent at the parent repo so it loads parent-level config", () => {
		const root = resolveAgentConfigRoot({
			workspaceId: "tools",
			repoPath: "/home/user/code/tools",
			classification,
		});

		expect(root).toBe("/home/user/code/tools");
	});

	it("keeps an impl agent rooted at its own repo, never descending into a parent or sibling", () => {
		const root = resolveAgentConfigRoot({
			workspaceId: "fleet-kanban",
			repoPath: "/home/user/code/tools/fleet-kanban",
			classification,
		});

		expect(root).toBe("/home/user/code/tools/fleet-kanban");
	});

	it("uses the workspace's own repo when the layout is flat and there is no architect", () => {
		const flat = classifyArchitectWorkspace([
			{ workspaceId: "repo1", repoPath: "/home/user/code/repo1" },
			{ workspaceId: "repo2", repoPath: "/home/user/code/repo2" },
		]);

		const root = resolveAgentConfigRoot({
			workspaceId: "repo1",
			repoPath: "/home/user/code/repo1",
			classification: flat,
		});

		expect(root).toBe("/home/user/code/repo1");
	});
});

describe("resolveHomeAgentCwd (home-agent launch seam)", () => {
	const registeredIndex = [
		{ workspaceId: "tools", repoPath: "/home/user/code/tools" },
		{ workspaceId: "fleet-kanban", repoPath: "/home/user/code/tools/fleet-kanban" },
	];

	it("launches the architect's home agent at the parent repo (parent-level config)", async () => {
		const cwd = await resolveHomeAgentCwd({
			workspaceId: "tools",
			workspacePath: "/home/user/code/tools",
			listWorkspaces: async () => registeredIndex,
		});

		expect(cwd).toBe("/home/user/code/tools");
	});

	it("launches an impl's home agent in its own repo, not the architect's parent", async () => {
		const cwd = await resolveHomeAgentCwd({
			workspaceId: "fleet-kanban",
			workspacePath: "/home/user/code/tools/fleet-kanban",
			listWorkspaces: async () => registeredIndex,
		});

		expect(cwd).toBe("/home/user/code/tools/fleet-kanban");
	});

	it("degrades to the workspace's own path when the registry cannot be read", async () => {
		const cwd = await resolveHomeAgentCwd({
			workspaceId: "tools",
			workspacePath: "/home/user/code/tools",
			listWorkspaces: async () => {
				throw new Error("index unavailable");
			},
		});

		expect(cwd).toBe("/home/user/code/tools");
	});
});

describe("buildArchitectContextPreamble", () => {
	it("lists each overseen sub-repo's id and path when a workspace is the architect", () => {
		const workspaces = [
			{ workspaceId: "tools", repoPath: "/home/user/code/tools" },
			{ workspaceId: "fleet", repoPath: "/home/user/code/tools/fleet" },
			{ workspaceId: "fleet-kanban", repoPath: "/home/user/code/tools/fleet-kanban" },
		];
		const preamble = buildArchitectContextPreamble(classifyArchitectWorkspace(workspaces), workspaces);

		expect(preamble).toContain("fleet (/home/user/code/tools/fleet)");
		expect(preamble).toContain("fleet-kanban (/home/user/code/tools/fleet-kanban)");
		// The architect's own repo is not one of its overseen sub-repositories.
		expect(preamble).not.toContain("tools (/home/user/code/tools)");
	});

	it("names a lone child when the architect oversees exactly one sub-repo", () => {
		const workspaces = [
			{ workspaceId: "tools", repoPath: "/home/user/code/tools" },
			{ workspaceId: "fleet-kanban", repoPath: "/home/user/code/tools/fleet-kanban" },
		];
		const preamble = buildArchitectContextPreamble(classifyArchitectWorkspace(workspaces), workspaces);

		expect(preamble).toContain("fleet-kanban (/home/user/code/tools/fleet-kanban)");
	});

	it("injects nothing when the layout is flat with no architect", () => {
		const workspaces = [
			{ workspaceId: "repo1", repoPath: "/home/user/code/repo1" },
			{ workspaceId: "repo2", repoPath: "/home/user/code/repo2" },
		];

		expect(buildArchitectContextPreamble(classifyArchitectWorkspace(workspaces), workspaces)).toBe("");
	});
});

describe("resolveHomeAgentContext (home-agent initial-context seam)", () => {
	const registeredIndex = [
		{ workspaceId: "tools", repoPath: "/home/user/code/tools" },
		{ workspaceId: "fleet-kanban", repoPath: "/home/user/code/tools/fleet-kanban" },
	];

	it("seeds the architect's home agent with awareness of its overseen sub-repos", async () => {
		const context = await resolveHomeAgentContext({
			workspaceId: "tools",
			workspacePath: "/home/user/code/tools",
			listWorkspaces: async () => registeredIndex,
		});

		expect(context.cwd).toBe("/home/user/code/tools");
		expect(context.architectContextPreamble).toContain("fleet-kanban (/home/user/code/tools/fleet-kanban)");
	});

	it("injects no architect context for an impl workspace's home agent", async () => {
		const context = await resolveHomeAgentContext({
			workspaceId: "fleet-kanban",
			workspacePath: "/home/user/code/tools/fleet-kanban",
			listWorkspaces: async () => registeredIndex,
		});

		expect(context.cwd).toBe("/home/user/code/tools/fleet-kanban");
		expect(context.architectContextPreamble).toBe("");
	});

	it("injects no architect context when the layout is flat with no architect", async () => {
		const context = await resolveHomeAgentContext({
			workspaceId: "repo1",
			workspacePath: "/home/user/code/repo1",
			listWorkspaces: async () => [
				{ workspaceId: "repo1", repoPath: "/home/user/code/repo1" },
				{ workspaceId: "repo2", repoPath: "/home/user/code/repo2" },
			],
		});

		expect(context.architectContextPreamble).toBe("");
	});

	it("degrades to no architect context when the registry cannot be read", async () => {
		const context = await resolveHomeAgentContext({
			workspaceId: "tools",
			workspacePath: "/home/user/code/tools",
			listWorkspaces: async () => {
				throw new Error("index unavailable");
			},
		});

		expect(context.cwd).toBe("/home/user/code/tools");
		expect(context.architectContextPreamble).toBe("");
	});
});
