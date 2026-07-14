import matter from "gray-matter";
import type { RuntimeAgentId } from "../core/api-contract";
import { runtimeAgentIdSchema } from "../core/api-contract";

/**
 * Parses a Kanban card authored as a Markdown document with optional YAML
 * frontmatter into the fields the `task create` command already understands.
 *
 * The frontmatter is the small, structured "envelope" (agent, auto-review,
 * issue, …) and the Markdown body is the card prompt, kept verbatim. This lets
 * a card live on disk (e.g. `docs/scratch/tasks/`) and be reused, committed, and
 * referenced by path instead of hand-massaging many CLI flags.
 *
 * This module is intentionally a pure, non-entry helper (no CLI/runtime imports)
 * so it can be unit-tested without booting the command entry.
 */

const VALID_AGENT_IDS = runtimeAgentIdSchema.options;

/** Frontmatter keys we recognize. Anything else is a hard error. */
const KNOWN_FRONTMATTER_KEYS = [
	"title",
	"agent",
	"model",
	"base-ref",
	"auto-review",
	"plan",
	"issue",
	"code-references",
	"links",
] as const;

const AUTO_REVIEW_VALUES = ["pr", "commit", "off"] as const;
type AutoReviewValue = (typeof AUTO_REVIEW_VALUES)[number];

/**
 * A code reference the agent must expand itself before writing code. The create
 * path never runs git/gh or embeds diffs — it only records the pointer and
 * renders an instruction to expand it.
 */
export type ParsedCodeReference = { kind: "commit"; sha: string } | { kind: "pr"; number: string };

export interface ParsedTaskCard {
	title?: string;
	/** `undefined` = leave to default; `null` = explicit "default" (clear override). */
	agentId?: RuntimeAgentId | null;
	agentModel?: string;
	baseRef?: string;
	startInPlanMode?: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: "commit" | "pr";
	externalIssueRef?: string;
	/** Task ids to link as dependencies after the card is created. */
	links: string[];
	codeReferences: ParsedCodeReference[];
	/** The Markdown body (verbatim) plus any rendered "Code references" section. */
	prompt: string;
}

function frontmatterError(message: string): Error {
	return new Error(`Invalid card frontmatter: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectString(key: string, value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw frontmatterError(`"${key}" must be a non-empty string.`);
	}
	return value.trim();
}

function parseAgentValue(value: unknown): RuntimeAgentId | null {
	const raw = expectString("agent", value);
	if (raw === "default") {
		return null;
	}
	const result = runtimeAgentIdSchema.safeParse(raw);
	if (!result.success) {
		throw frontmatterError(`"agent" must be one of: ${VALID_AGENT_IDS.join(", ")}, default (got "${raw}").`);
	}
	return result.data;
}

function parseAutoReviewValue(value: unknown): { autoReviewEnabled: boolean; autoReviewMode?: "commit" | "pr" } {
	const raw = expectString("auto-review", value);
	if (!(AUTO_REVIEW_VALUES as readonly string[]).includes(raw)) {
		throw frontmatterError(`"auto-review" must be one of: ${AUTO_REVIEW_VALUES.join(", ")} (got "${raw}").`);
	}
	const mode = raw as AutoReviewValue;
	if (mode === "off") {
		return { autoReviewEnabled: false };
	}
	return { autoReviewEnabled: true, autoReviewMode: mode };
}

function parseBooleanValue(key: string, value: unknown): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	throw frontmatterError(`"${key}" must be a boolean (true or false).`);
}

function parseStringList(key: string, value: unknown): string[] {
	if (!Array.isArray(value)) {
		throw frontmatterError(`"${key}" must be a list.`);
	}
	return value.map((entry, index) => {
		if (typeof entry !== "string" || entry.trim().length === 0) {
			throw frontmatterError(`"${key}" entry #${index + 1} must be a non-empty string.`);
		}
		return entry.trim();
	});
}

/**
 * Normalizes one `code-references` entry. Accepts a commit SHA (7-40 hex chars)
 * or a PR number (`#43` or `43`). Pure digits are treated as a PR number, which
 * matches the operator convention (`40cc6b6` = SHA, `#43`/`43` = PR).
 */
export function parseCodeReference(raw: string): ParsedCodeReference {
	const value = raw.trim();
	const prMatch = value.match(/^#?(\d+)$/u);
	if (prMatch) {
		return { kind: "pr", number: prMatch[1] };
	}
	if (/^[0-9a-f]{7,40}$/iu.test(value)) {
		return { kind: "commit", sha: value.toLowerCase() };
	}
	throw frontmatterError(
		`code-references entry "${raw}" is not a commit SHA (7-40 hex chars) or a PR number (#43 or 43).`,
	);
}

function parseCodeReferences(value: unknown): ParsedCodeReference[] {
	if (!Array.isArray(value)) {
		throw frontmatterError(`"code-references" must be a list.`);
	}
	return value.map((entry) => {
		if (typeof entry === "number" && Number.isInteger(entry) && entry >= 0) {
			// YAML happily parses `- 43` as a number; treat it as a PR number.
			return parseCodeReference(String(entry));
		}
		if (typeof entry !== "string" || entry.trim().length === 0) {
			throw frontmatterError(`"code-references" entries must be commit SHAs or PR numbers.`);
		}
		return parseCodeReference(entry);
	});
}

const CODE_REFERENCES_HEADING = /^\s{0,3}#{1,6}\s+code references\b/imu;

function renderCodeReferencesSection(refs: ParsedCodeReference[]): string {
	const lines = refs.map((ref) =>
		ref.kind === "pr"
			? `- PR #${ref.number} — run \`gh pr view ${ref.number} --diff\` and read the diff before writing code.`
			: `- \`${ref.sha}\` — run \`git show ${ref.sha}\` and read the diff before writing code.`,
	);
	return [
		"## Code references (read these first)",
		"",
		"Expand each reference yourself before writing any code — the card records the pointers only, not the diffs:",
		...lines,
	].join("\n");
}

/** Derives a title from the body: the first ATX heading text, else the first non-empty line. */
export function deriveCardTitleFromBody(body: string): string | undefined {
	const firstLine = body
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine) {
		return undefined;
	}
	const heading = firstLine.match(/^#{1,6}\s+(.*)$/u);
	const derived = (heading ? heading[1] : firstLine).trim();
	return derived.length > 0 ? derived : undefined;
}

/**
 * Parses a card Markdown document (frontmatter + body) into `ParsedTaskCard`.
 * Throws a clear error for unknown keys, bad enum values, or malformed
 * code-references entries.
 */
export function parseTaskCardDocument(source: string): ParsedTaskCard {
	let data: Record<string, unknown>;
	let content: string;
	try {
		const parsed = matter(source);
		content = parsed.content;
		data = isPlainObject(parsed.data) ? parsed.data : {};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw frontmatterError(`YAML could not be parsed (${reason}).`);
	}

	const unknownKeys = Object.keys(data).filter((key) => !(KNOWN_FRONTMATTER_KEYS as readonly string[]).includes(key));
	if (unknownKeys.length > 0) {
		throw frontmatterError(
			`unknown key(s): ${unknownKeys.join(", ")}. Valid keys: ${KNOWN_FRONTMATTER_KEYS.join(", ")}.`,
		);
	}

	const card: ParsedTaskCard = { links: [], codeReferences: [], prompt: "" };

	if (data.title !== undefined) {
		card.title = expectString("title", data.title);
	}
	if (data.agent !== undefined) {
		card.agentId = parseAgentValue(data.agent);
	}
	if (data.model !== undefined) {
		card.agentModel = expectString("model", data.model);
	}
	if (data["base-ref"] !== undefined) {
		card.baseRef = expectString("base-ref", data["base-ref"]);
	}
	if (data.plan !== undefined) {
		card.startInPlanMode = parseBooleanValue("plan", data.plan);
	}
	if (data.issue !== undefined) {
		card.externalIssueRef = expectString("issue", data.issue);
	}
	if (data.links !== undefined) {
		card.links = parseStringList("links", data.links);
	}
	if (data["code-references"] !== undefined) {
		card.codeReferences = parseCodeReferences(data["code-references"]);
	}

	// auto-review defaults to `pr` for the Markdown-card path (the new default;
	// the flag-only `task create` still defaults to commit).
	const autoReview =
		data["auto-review"] !== undefined
			? parseAutoReviewValue(data["auto-review"])
			: { autoReviewEnabled: true, autoReviewMode: "pr" as const };
	card.autoReviewEnabled = autoReview.autoReviewEnabled;
	card.autoReviewMode = autoReview.autoReviewMode;

	const body = content.trim();
	if (card.title === undefined) {
		card.title = deriveCardTitleFromBody(body);
	}

	// Render the code-references instruction unless the body already carries its
	// own "Code references" section (never duplicate).
	const shouldRenderRefs = card.codeReferences.length > 0 && !CODE_REFERENCES_HEADING.test(body);
	card.prompt = shouldRenderRefs ? `${body}\n\n${renderCodeReferencesSection(card.codeReferences)}` : body;

	return card;
}

/** Where the card Markdown comes from, resolved from the `--file`/`--markdown` flags. */
export type TaskCardSourceRequest =
	| { kind: "none" }
	| { kind: "inline"; text: string }
	| { kind: "stdin" }
	| { kind: "file"; path: string };

/**
 * Resolves which card source the create command should read from `--file` /
 * `--markdown`. `--file -` means stdin. The two flags are mutually exclusive.
 */
export function resolveCardSourceRequest(opts: { file?: string; markdown?: string }): TaskCardSourceRequest {
	const hasFile = opts.file !== undefined;
	const hasMarkdown = opts.markdown !== undefined;
	if (hasFile && hasMarkdown) {
		throw new Error("Pass either --file or --markdown, not both.");
	}
	if (hasMarkdown) {
		return { kind: "inline", text: opts.markdown ?? "" };
	}
	if (hasFile) {
		const path = (opts.file ?? "").trim();
		if (path === "-") {
			return { kind: "stdin" };
		}
		if (path.length === 0) {
			throw new Error("--file requires a path (or - for stdin).");
		}
		return { kind: "file", path };
	}
	return { kind: "none" };
}

/**
 * CLI flag values (already parsed) that can override frontmatter. `undefined`
 * means the flag was not passed; `null` on agent/model means an explicit
 * "default" that clears any override.
 */
export interface TaskCardCreateFlags {
	title?: string;
	prompt?: string;
	baseRef?: string;
	startInPlanMode?: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: "commit" | "pr";
	agentId?: RuntimeAgentId | null;
	agentModel?: string | null;
	externalIssueRef?: string;
}

export interface ResolvedTaskCardCreate {
	title?: string;
	prompt: string;
	baseRef?: string;
	startInPlanMode?: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: "commit" | "pr";
	agentId?: RuntimeAgentId;
	agentModel?: string;
	externalIssueRef?: string;
	links: string[];
}

function pick<T>(flag: T | undefined, fromCard: T | undefined): T | undefined {
	return flag !== undefined ? flag : fromCard;
}

/**
 * Merges a parsed card with explicit CLI flags. Flags always win over
 * frontmatter, so a single card file can be reused with one field tweaked from
 * the command line. Throws if no prompt is available from either source.
 */
export function resolveTaskCardCreate(
	card: ParsedTaskCard | undefined,
	flags: TaskCardCreateFlags,
): ResolvedTaskCardCreate {
	const prompt = pick(flags.prompt, card?.prompt);
	if (prompt === undefined || prompt.trim().length === 0) {
		throw new Error("task create requires a prompt — pass --prompt, --file, or --markdown.");
	}
	// null on agent/model is an explicit "default" (no override); collapse to
	// undefined for the create path, which has no separate clear semantics.
	const agentId = pick(flags.agentId, card?.agentId) ?? undefined;
	const agentModel = pick(flags.agentModel, card?.agentModel) ?? undefined;
	return {
		title: pick(flags.title, card?.title),
		prompt,
		baseRef: pick(flags.baseRef, card?.baseRef),
		startInPlanMode: pick(flags.startInPlanMode, card?.startInPlanMode),
		autoReviewEnabled: pick(flags.autoReviewEnabled, card?.autoReviewEnabled),
		autoReviewMode: pick(flags.autoReviewMode, card?.autoReviewMode),
		agentId,
		agentModel,
		externalIssueRef: pick(flags.externalIssueRef, card?.externalIssueRef),
		links: card?.links ?? [],
	};
}
