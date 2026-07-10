// Architect detection + agent config rooting (Architect Steering, Phase A).
//
// A registered workspace whose repoPath *contains* other registered workspaces'
// repoPaths is the board's overarching agent — the "architect" that oversees the
// impl repos nested beneath it. Detection is pure containment over the workspace
// index: no explicit flag, it falls straight out of the `./` over `./repoN`
// nesting (e.g. `tools` contains `fleet-kanban`, so `tools` is the architect).
//
// See docs/design/architect-steering.md §3 and §5 (Cards A1, A2).

import { isPathWithinRoot } from "../workspace/path-sandbox";
import { type FleetAgentHelpResult, runFleetAgentHelp as runFleetAgentHelpViaCli } from "./fleet-cli";

export interface RegisteredWorkspace {
	workspaceId: string;
	repoPath: string;
}

export interface ArchitectClassification {
	/** The overseer workspace whose repo contains other registered repos, or `null` for a flat/peer layout. */
	architectWorkspaceId: string | null;
	/** Every workspace contained (at any depth) by the architect. Empty when there is no architect. */
	implWorkspaceIds: string[];
}

/**
 * Whether `parent`'s repo strictly contains `child`'s repo.
 *
 * Segment-aware (via {@link isPathWithinRoot}), so `/a/tools` does NOT contain
 * `/a/tools-x`. "Strict" excludes equal paths: a workspace never contains itself,
 * and two workspaces pointing at the same repo are peers, not parent/child.
 */
function strictlyContains(parent: RegisteredWorkspace, child: RegisteredWorkspace): boolean {
	if (parent.workspaceId === child.workspaceId) {
		return false;
	}
	// Equal paths contain each other in both directions; requiring the reverse to
	// be false leaves only true (strict) containment.
	return isPathWithinRoot(parent.repoPath, child.repoPath) && !isPathWithinRoot(child.repoPath, parent.repoPath);
}

/**
 * Classify the registered workspaces into an architect + the impl repos it oversees.
 *
 * The architect is the OUTERMOST container: a workspace that strictly contains at
 * least one other registered workspace yet is itself contained by none. Deepest
 * containing parent wins by construction — an inner container such as `/a/b` is
 * excluded because `/a` contains it, leaving `/a` as the sole architect over both
 * `/a/b` and `/a/b/c`. A flat/peer layout (or `tools` vs `tools-x` siblings) has
 * no container, hence no architect.
 */
export function classifyArchitectWorkspace(workspaces: RegisteredWorkspace[]): ArchitectClassification {
	const rootContainers = workspaces.filter((candidate) => {
		const containsAnother = workspaces.some((other) => strictlyContains(candidate, other));
		if (!containsAnother) {
			return false;
		}
		const hasContainingParent = workspaces.some((other) => strictlyContains(other, candidate));
		return !hasContainingParent;
	});

	// The board runs a single architect. With more than one disjoint containment
	// tree, prefer the one overseeing the most repos (repoPath tie-break) so the
	// choice is deterministic across restarts.
	const architect = [...rootContainers].sort((left, right) => {
		const leftCount = workspaces.filter((ws) => strictlyContains(left, ws)).length;
		const rightCount = workspaces.filter((ws) => strictlyContains(right, ws)).length;
		if (leftCount !== rightCount) {
			return rightCount - leftCount;
		}
		return left.repoPath.localeCompare(right.repoPath);
	})[0];

	if (!architect) {
		return {
			architectWorkspaceId: null,
			implWorkspaceIds: [],
		};
	}

	const implWorkspaceIds = workspaces.filter((ws) => strictlyContains(architect, ws)).map((ws) => ws.workspaceId);

	return {
		architectWorkspaceId: architect.workspaceId,
		implWorkspaceIds,
	};
}

/**
 * Initial-context section that makes the architect's home agent aware of the
 * sub-repositories it oversees. Pure over the classification + workspace index:
 * lists each impl workspace's id and repo path so the overseer knows, straight
 * from the board's live index, which sub-repos it spans. They are subdirectories
 * of its cwd, so it already reads across them with normal file tools — this only
 * seeds awareness, it grants no new capability.
 *
 * When `fleetToolsHelp` is supplied (the curated output of `fleet help --agent`),
 * it is appended below the sub-repo list so the architect knows it drives the
 * board through the `fleet` CLI. Omit it (or pass `null`) to inject the sub-repo
 * list alone — e.g. when the CLI is unavailable.
 *
 * Returns `""` when there is no architect (flat/peer layout) or the architect
 * oversees nothing, so a non-architect workspace injects nothing.
 */
export function buildArchitectContextPreamble(
	classification: ArchitectClassification,
	workspaces: RegisteredWorkspace[],
	fleetToolsHelp?: string | null,
): string {
	if (classification.architectWorkspaceId === null) {
		return "";
	}
	const overseen = classification.implWorkspaceIds
		.map((id) => workspaces.find((ws) => ws.workspaceId === id))
		.filter((ws): ws is RegisteredWorkspace => ws !== undefined);
	if (overseen.length === 0) {
		return "";
	}
	const list = overseen.map((ws) => `- ${ws.workspaceId} (${ws.repoPath})`).join("\n");
	const subRepos = `# Architect Workspace

You are the architect overseeing these sub-repositories:
${list}

They live as subdirectories of your workspace, so you can read across them with your normal file tools.`;

	const tools = fleetToolsHelp?.trim();
	return tools ? `${subRepos}\n\n${tools}` : subRepos;
}

export interface ResolveAgentConfigRootInput {
	workspaceId: string;
	/** The workspace's own registered repo path. */
	repoPath: string;
	classification: ArchitectClassification;
}

/**
 * Resolve the directory whose config an agent session should load — `agent config
 * = f(cwd)`.
 *
 * Both roles root at their OWN workspace repo, but for different reasons, and the
 * classification is what tells them apart:
 *   • architect — its repo *is* the parent dir, so rooting there loads the
 *     parent-level `.claude/` + `AGENTS.md` + `CLAUDE.md` and never descends into
 *     a child repo's config.
 *   • impl (or peer) — its own repo, so it loads child config and never inherits
 *     the architect's parent config nor a sibling child's.
 *
 * This is the single seam Phase A routes the home/workspace agent cwd through;
 * later phases (cross-repo dispatch) extend the same role split.
 */
export function resolveAgentConfigRoot(input: ResolveAgentConfigRootInput): string {
	if (input.workspaceId === input.classification.architectWorkspaceId) {
		// Architect: parent-rooted config, which is its own repo.
		return input.repoPath;
	}
	// Impl / peer: strictly its own repo — never the architect's parent config.
	return input.repoPath;
}

export interface ResolveHomeAgentCwdInput {
	workspaceId: string;
	workspacePath: string;
	/** Loads the registered workspace index ({ workspaceId → repoPath }). */
	listWorkspaces: () => Promise<RegisteredWorkspace[]>;
}

export interface HomeAgentContext {
	/** Directory the home agent launches in (parent config for the architect, own repo otherwise). */
	cwd: string;
	/**
	 * Architect awareness to seed as the home agent's initial context, or `""`
	 * when this workspace is not the architect (impl/peer/flat).
	 */
	architectContextPreamble: string;
	/**
	 * A user-facing warning to surface when the architect started without its
	 * fleet tools (the `fleet` CLI is missing or errored). `null` when the fleet
	 * tools loaded, or for a non-architect workspace. The session still starts —
	 * this only tells the user its board commands are unavailable.
	 */
	fleetToolsWarning: string | null;
}

/** Resolves the architect's fleet tool instructions; injected so tests can stub the CLI. */
export type FleetAgentHelpRunner = (cwd: string) => Promise<FleetAgentHelpResult>;

function describeMissingFleetTools(reason: string): string {
	return `Kanban Agent started without its fleet board tools: ${reason}. It can still read the sub-repositories, but \`fleet\` board commands are unavailable until this is fixed.`;
}

/**
 * The launch context for a home/workspace agent, routed through architect
 * classification: the cwd it roots at and — only for the architect workspace —
 * the awareness preamble naming the sub-repositories it oversees plus the curated
 * `fleet help --agent` tool list appended below it.
 *
 * This is the seam the tRPC `startTaskSession` handler calls for the home-agent
 * branch: it classifies the registered index once and, per role, roots the agent
 * (architect → parent config, impl → own config) and seeds architect awareness
 * (architect → sub-repo list + fleet tools, everyone else → nothing). If the
 * index can't be read it degrades to the workspace's own path with no preamble —
 * the pre-architect behavior — so a transient index miss never blocks starting
 * an agent. If the fleet CLI can't be resolved the architect still starts with
 * the sub-repo list, and `fleetToolsWarning` carries the reason to show the user.
 */
export async function resolveHomeAgentContext(
	input: ResolveHomeAgentCwdInput,
	runFleetAgentHelp: FleetAgentHelpRunner = runFleetAgentHelpViaCli,
): Promise<HomeAgentContext> {
	let workspaces: RegisteredWorkspace[];
	try {
		workspaces = await input.listWorkspaces();
	} catch {
		return { cwd: input.workspacePath, architectContextPreamble: "", fleetToolsWarning: null };
	}
	const classification = classifyArchitectWorkspace(workspaces);
	const cwd = resolveAgentConfigRoot({
		workspaceId: input.workspaceId,
		repoPath: input.workspacePath,
		classification,
	});

	if (input.workspaceId !== classification.architectWorkspaceId) {
		return { cwd, architectContextPreamble: "", fleetToolsWarning: null };
	}

	const fleet = await runFleetAgentHelp(cwd);
	const architectContextPreamble = buildArchitectContextPreamble(
		classification,
		workspaces,
		fleet.ok ? fleet.instructions : null,
	);
	const fleetToolsWarning = fleet.ok ? null : describeMissingFleetTools(fleet.error);
	return { cwd, architectContextPreamble, fleetToolsWarning };
}

/**
 * The cwd a home/workspace agent should launch in. Thin accessor over
 * {@link resolveHomeAgentContext} for callers that only need the directory; it
 * skips the fleet CLI (empty instructions) since the cwd never depends on it.
 */
export async function resolveHomeAgentCwd(input: ResolveHomeAgentCwdInput): Promise<string> {
	return (await resolveHomeAgentContext(input, async () => ({ ok: true, instructions: "" }))).cwd;
}
