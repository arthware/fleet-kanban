import path from "node:path";

/**
 * The single external dependency of doctrine resolution: read a file's text, or
 * null when it does not exist. Injected so the module is testable without touching
 * the filesystem (Constitution Article 4 — a clean, narrow, mockable seam).
 */
export type ReadFileIfExists = (filePath: string) => Promise<string | null>;

export interface DoctrineLookup {
	/** Absolute path of the repo a card works in. */
	repoPath: string;
	/** Repo name used to namespace root-fallback doctrine. Required for the fallback. */
	repoName?: string;
	/** Absolute path of the fleet root that owns per-repo doctrine. Enables the fallback. */
	fleetRoot?: string;
}

export interface ResolvedDoctrine {
	constitution: string;
	source: "in-repo" | "root-fallback";
	path: string;
}

/** Where a repo may carry its own doctrine in-tree. */
const IN_REPO_CONSTITUTION = "docs/architecture/constitution.md";
/** Where the fleet root keeps a repo's doctrine so the source repo stays pristine. */
const ROOT_DOCTRINE_DIR = ".fleet/doctrine";

/**
 * Resolve a repo's constitution, in-repo first then falling back to architect-owned
 * doctrine at the fleet root. The in-repo copy is an opt-in; the root location is the
 * non-invasive default. Returns null when neither location has one.
 *
 * See docs/design/architect-doctrine-placement.md.
 */
export async function loadDoctrine(lookup: DoctrineLookup, read: ReadFileIfExists): Promise<ResolvedDoctrine | null> {
	const inRepoPath = path.join(lookup.repoPath, IN_REPO_CONSTITUTION);
	const inRepo = await read(inRepoPath);
	if (inRepo !== null) {
		return { constitution: inRepo, source: "in-repo", path: inRepoPath };
	}

	if (lookup.fleetRoot && lookup.repoName) {
		const rootPath = path.join(lookup.fleetRoot, ROOT_DOCTRINE_DIR, lookup.repoName, "constitution.md");
		const atRoot = await read(rootPath);
		if (atRoot !== null) {
			return { constitution: atRoot, source: "root-fallback", path: rootPath };
		}
	}

	return null;
}

export const CONSTITUTION_DIRECTIVE_HEADER =
	"Follow this project constitution — it is the non-negotiable core for this change:";

/**
 * Prepend the constitution to a card/agent prompt so it can't be skipped. The full
 * (short) text is inlined rather than pointed at, so it works identically whether the
 * doctrine lives in-repo or at the fleet root. A null constitution leaves the prompt as-is.
 */
export function prependConstitution(prompt: string, constitution: string | null): string {
	if (!constitution) {
		return prompt;
	}
	return `${CONSTITUTION_DIRECTIVE_HEADER}\n\n${constitution.trim()}\n\n---\n\n${prompt}`;
}
