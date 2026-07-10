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

/**
 * The cwd a home/workspace agent should launch in, routed through architect
 * classification.
 *
 * This is the seam the tRPC `startTaskSession` handler calls for the home-agent
 * branch: it classifies the registered index and roots the agent per role
 * (architect → parent config, impl → own config). If the index can't be read it
 * degrades to the workspace's own path — the pre-architect behavior — so a
 * transient index miss never blocks starting an agent.
 */
export async function resolveHomeAgentCwd(input: ResolveHomeAgentCwdInput): Promise<string> {
	let workspaces: RegisteredWorkspace[];
	try {
		workspaces = await input.listWorkspaces();
	} catch {
		return input.workspacePath;
	}
	const classification = classifyArchitectWorkspace(workspaces);
	return resolveAgentConfigRoot({
		workspaceId: input.workspaceId,
		repoPath: input.workspacePath,
		classification,
	});
}
