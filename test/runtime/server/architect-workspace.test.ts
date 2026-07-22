import { describe, expect, it } from "vitest";

import type { ReadFileIfExists } from "../../../src/prompts/doctrine";
import {
	buildArchitectContextPreamble,
	classifyArchitectWorkspace,
	resolveAgentConfigRoot,
	resolveDoctrineScope,
	resolveHomeAgentContext,
	resolveHomeAgentCwd,
	selectArchitectAwareProjects,
} from "../../../src/server/architect-workspace";

/** Path→content fake for the injected doctrine-file seam — the only external dependency (Article 4). */
function fakeReader(files: Record<string, string>): ReadFileIfExists {
	return async (p: string) => (p in files ? files[p] : null);
}

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

describe("resolveDoctrineScope", () => {
	it("given an overseen repo, when scoped, then it yields the architect root and the fleet-root-relative repo name", () => {
		// given
		const workspaces = [
			{ workspaceId: "tools", repoPath: "/home/user/code/tools" },
			{ workspaceId: "fleet-kanban", repoPath: "/home/user/code/tools/fleet-kanban" },
		];

		// when
		const scope = resolveDoctrineScope("/home/user/code/tools/fleet-kanban", workspaces);

		// then
		expect(scope).toEqual({ fleetRoot: "/home/user/code/tools", repoName: "fleet-kanban" });
	});

	it("given a repo nested below a nested container, when scoped, then repoName keeps the fleet-root-relative path", () => {
		// given — the outermost container is the architect, so the name preserves the intermediate segment
		const workspaces = [
			{ workspaceId: "top", repoPath: "/root/a" },
			{ workspaceId: "leaf", repoPath: "/root/a/b/c" },
		];

		// when
		const scope = resolveDoctrineScope("/root/a/b/c", workspaces);

		// then
		expect(scope).toEqual({ fleetRoot: "/root/a", repoName: "b/c" });
	});

	it("given a flat/peer board, when scoped, then no scope is produced (in-repo resolution only)", () => {
		// given
		const workspaces = [
			{ workspaceId: "repo1", repoPath: "/home/user/code/repo1" },
			{ workspaceId: "repo2", repoPath: "/home/user/code/repo2" },
		];

		// when
		const scope = resolveDoctrineScope("/home/user/code/repo1", workspaces);

		// then
		expect(scope).toEqual({});
	});

	it("given the architect's own path, when scoped, then no scope is produced (it is not an overseen repo)", () => {
		// given
		const workspaces = [
			{ workspaceId: "tools", repoPath: "/home/user/code/tools" },
			{ workspaceId: "fleet-kanban", repoPath: "/home/user/code/tools/fleet-kanban" },
		];

		// when
		const scope = resolveDoctrineScope("/home/user/code/tools", workspaces);

		// then
		expect(scope).toEqual({});
	});
});

describe("selectArchitectAwareProjects", () => {
	const architectBoard = [
		{ workspaceId: "tools", repoPath: "/home/user/code/tools" },
		{ workspaceId: "fleet-kanban", repoPath: "/home/user/code/tools/fleet-kanban" },
	];

	it("reports the architect and hides it from the selectable project list", () => {
		const selection = selectArchitectAwareProjects({
			workspaces: architectBoard,
			activeWorkspaceId: "fleet-kanban",
			preferredCurrentProjectId: "fleet-kanban",
		});

		expect(selection.architectWorkspaceId).toBe("tools");
		expect(selection.selectableWorkspaceIds).toEqual(["fleet-kanban"]);
		expect(selection.currentProjectId).toBe("fleet-kanban");
	});

	it("never selects the architect as the current project, even when it is requested", () => {
		const selection = selectArchitectAwareProjects({
			workspaces: architectBoard,
			activeWorkspaceId: "tools",
			preferredCurrentProjectId: "tools",
		});

		// The architect is not a selectable board, so the current project falls
		// through to the only impl repo rather than the overseer.
		expect(selection.currentProjectId).toBe("fleet-kanban");
		expect(selection.selectableWorkspaceIds).not.toContain("tools");
	});

	it("leaves a flat/peer board unchanged with no architect", () => {
		const selection = selectArchitectAwareProjects({
			workspaces: [
				{ workspaceId: "repo1", repoPath: "/home/user/code/repo1" },
				{ workspaceId: "repo2", repoPath: "/home/user/code/repo2" },
			],
			activeWorkspaceId: "repo2",
			preferredCurrentProjectId: "repo2",
		});

		expect(selection.architectWorkspaceId).toBeNull();
		expect(selection.selectableWorkspaceIds).toEqual(["repo1", "repo2"]);
		expect(selection.currentProjectId).toBe("repo2");
	});

	it("falls back to the first impl repo when no preference resolves", () => {
		const selection = selectArchitectAwareProjects({
			workspaces: architectBoard,
			activeWorkspaceId: null,
			preferredCurrentProjectId: null,
		});

		expect(selection.currentProjectId).toBe("fleet-kanban");
	});

	it("yields no current project when the architect is the only registered workspace", () => {
		const selection = selectArchitectAwareProjects({
			workspaces: [
				{ workspaceId: "tools", repoPath: "/home/user/code/tools" },
				{ workspaceId: "fleet-kanban", repoPath: "/home/user/code/tools/fleet-kanban" },
			].slice(0, 1),
			activeWorkspaceId: "tools",
			preferredCurrentProjectId: "tools",
		});

		// A lone workspace is a flat board (it contains nothing), so it stays a
		// normal selectable project rather than becoming a hidden architect.
		expect(selection.architectWorkspaceId).toBeNull();
		expect(selection.selectableWorkspaceIds).toEqual(["tools"]);
		expect(selection.currentProjectId).toBe("tools");
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

	it("appends the fleet tool instructions below the sub-repo list when they are provided", () => {
		const workspaces = [
			{ workspaceId: "tools", repoPath: "/home/user/code/tools" },
			{ workspaceId: "fleet-kanban", repoPath: "/home/user/code/tools/fleet-kanban" },
		];
		const fleetTools = "You drive the board via the `fleet` CLI.\nfleet task ls — production-line overview.";

		const preamble = buildArchitectContextPreamble(classifyArchitectWorkspace(workspaces), workspaces, fleetTools);

		expect(preamble).toContain("fleet-kanban (/home/user/code/tools/fleet-kanban)");
		expect(preamble).toContain("fleet task ls — production-line overview.");
		// The tool instructions sit below the sub-repo list, not above it.
		expect(preamble.indexOf("fleet-kanban (/home/user/code/tools/fleet-kanban)")).toBeLessThan(
			preamble.indexOf("fleet task ls — production-line overview."),
		);
	});

	it("returns only the sub-repo list when no fleet tools are provided", () => {
		const workspaces = [
			{ workspaceId: "tools", repoPath: "/home/user/code/tools" },
			{ workspaceId: "fleet-kanban", repoPath: "/home/user/code/tools/fleet-kanban" },
		];

		const preamble = buildArchitectContextPreamble(classifyArchitectWorkspace(workspaces), workspaces, null);

		expect(preamble).toContain("fleet-kanban (/home/user/code/tools/fleet-kanban)");
		expect(preamble).not.toContain("fleet task ls");
	});

	it("weaves the constitution into the preamble above the sub-repo list when one is provided", () => {
		const workspaces = [
			{ workspaceId: "tools", repoPath: "/home/user/code/tools" },
			{ workspaceId: "fleet-kanban", repoPath: "/home/user/code/tools/fleet-kanban" },
		];

		const preamble = buildArchitectContextPreamble(
			classifyArchitectWorkspace(workspaces),
			workspaces,
			null,
			"# Constitution\nArticle 1 — concepts first…",
		);

		expect(preamble).toContain("Article 1 — concepts first…");
		expect(preamble).toContain("fleet-kanban (/home/user/code/tools/fleet-kanban)");
		// The law leads; the workspace awareness follows it.
		expect(preamble.indexOf("Article 1 — concepts first…")).toBeLessThan(
			preamble.indexOf("fleet-kanban (/home/user/code/tools/fleet-kanban)"),
		);
	});

	it("leaves the preamble unchanged when no constitution resolves", () => {
		const workspaces = [
			{ workspaceId: "tools", repoPath: "/home/user/code/tools" },
			{ workspaceId: "fleet-kanban", repoPath: "/home/user/code/tools/fleet-kanban" },
		];

		const withConstitution = buildArchitectContextPreamble(
			classifyArchitectWorkspace(workspaces),
			workspaces,
			null,
			null,
		);
		const without = buildArchitectContextPreamble(classifyArchitectWorkspace(workspaces), workspaces, null);

		expect(withConstitution).toBe(without);
	});
});

describe("resolveHomeAgentContext (home-agent initial-context seam)", () => {
	const registeredIndex = [
		{ workspaceId: "tools", repoPath: "/home/user/code/tools" },
		{ workspaceId: "fleet-kanban", repoPath: "/home/user/code/tools/fleet-kanban" },
	];
	const fleetTools = "You drive the board via the `fleet` CLI.\nfleet task ls — production-line overview.";
	const provideFleetTools = async () => ({ ok: true as const, instructions: fleetTools });
	const fleetUnavailable = async () => ({ ok: false as const, error: "the fleet CLI was not found on PATH" });

	it("seeds the architect's home agent with both its sub-repos and its fleet tools", async () => {
		const context = await resolveHomeAgentContext(
			{
				workspaceId: "tools",
				workspacePath: "/home/user/code/tools",
				listWorkspaces: async () => registeredIndex,
			},
			provideFleetTools,
		);

		expect(context.cwd).toBe("/home/user/code/tools");
		expect(context.architectContextPreamble).toContain("fleet-kanban (/home/user/code/tools/fleet-kanban)");
		expect(context.architectContextPreamble).toContain("fleet task ls — production-line overview.");
		expect(context.fleetToolsWarning).toBeNull();
	});

	it("still seeds the sub-repo list and surfaces a warning when the fleet CLI is unavailable", async () => {
		const context = await resolveHomeAgentContext(
			{
				workspaceId: "tools",
				workspacePath: "/home/user/code/tools",
				listWorkspaces: async () => registeredIndex,
			},
			fleetUnavailable,
		);

		expect(context.architectContextPreamble).toContain("fleet-kanban (/home/user/code/tools/fleet-kanban)");
		expect(context.architectContextPreamble).not.toContain("fleet task ls");
		expect(context.fleetToolsWarning).toContain("the fleet CLI was not found on PATH");
	});

	it("does not run the fleet CLI, or warn, for an impl workspace's home agent", async () => {
		let fleetInvocations = 0;
		const context = await resolveHomeAgentContext(
			{
				workspaceId: "fleet-kanban",
				workspacePath: "/home/user/code/tools/fleet-kanban",
				listWorkspaces: async () => registeredIndex,
			},
			async () => {
				fleetInvocations += 1;
				return { ok: true as const, instructions: fleetTools };
			},
		);

		expect(context.cwd).toBe("/home/user/code/tools/fleet-kanban");
		expect(context.architectContextPreamble).toBe("");
		expect(context.fleetToolsWarning).toBeNull();
		expect(fleetInvocations).toBe(0);
	});

	it("injects no architect context when the layout is flat with no architect", async () => {
		const context = await resolveHomeAgentContext(
			{
				workspaceId: "repo1",
				workspacePath: "/home/user/code/repo1",
				listWorkspaces: async () => [
					{ workspaceId: "repo1", repoPath: "/home/user/code/repo1" },
					{ workspaceId: "repo2", repoPath: "/home/user/code/repo2" },
				],
			},
			provideFleetTools,
		);

		expect(context.architectContextPreamble).toBe("");
		expect(context.fleetToolsWarning).toBeNull();
	});

	it("degrades to no architect context when the registry cannot be read", async () => {
		const context = await resolveHomeAgentContext(
			{
				workspaceId: "tools",
				workspacePath: "/home/user/code/tools",
				listWorkspaces: async () => {
					throw new Error("index unavailable");
				},
			},
			provideFleetTools,
		);

		expect(context.cwd).toBe("/home/user/code/tools");
		expect(context.architectContextPreamble).toBe("");
		expect(context.fleetToolsWarning).toBeNull();
	});

	it("weaves the overseen repo's constitution into the architect's preamble", async () => {
		// given — the harness repo carries its constitution in-repo
		const read = fakeReader({
			"/home/user/code/tools/fleet-kanban/docs/architecture/constitution.md":
				"# Constitution\nArticle 1 — concepts first…",
		});

		// when
		const context = await resolveHomeAgentContext(
			{
				workspaceId: "tools",
				workspacePath: "/home/user/code/tools",
				listWorkspaces: async () => registeredIndex,
			},
			provideFleetTools,
			read,
		);

		// then — the architect is governed by the same doctrine as the cards it dispatches
		expect(context.architectContextPreamble).toContain("Article 1 — concepts first…");
		expect(context.architectContextPreamble).toContain("fleet-kanban (/home/user/code/tools/fleet-kanban)");
	});

	it("seeds only the sub-repo awareness when no overseen repo has a constitution", async () => {
		// given — no repo carries doctrine anywhere
		const read = fakeReader({});

		// when
		const context = await resolveHomeAgentContext(
			{
				workspaceId: "tools",
				workspacePath: "/home/user/code/tools",
				listWorkspaces: async () => registeredIndex,
			},
			provideFleetTools,
			read,
		);

		// then
		expect(context.architectContextPreamble).toContain("fleet-kanban (/home/user/code/tools/fleet-kanban)");
		expect(context.architectContextPreamble).not.toContain("Constitution");
	});

	it("injects no constitution for a non-architect (impl) workspace's home agent", async () => {
		// given — even if a constitution is readable, an impl home agent gets no architect preamble
		const read = fakeReader({
			"/home/user/code/tools/fleet-kanban/docs/architecture/constitution.md": "# Constitution\nArticle 1…",
		});

		// when
		const context = await resolveHomeAgentContext(
			{
				workspaceId: "fleet-kanban",
				workspacePath: "/home/user/code/tools/fleet-kanban",
				listWorkspaces: async () => registeredIndex,
			},
			provideFleetTools,
			read,
		);

		// then
		expect(context.architectContextPreamble).toBe("");
	});
});
