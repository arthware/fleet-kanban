/**
 * Destructive-command guard for autonomous agent launches.
 *
 * When a weaker/cheaper model runs unattended with `--dangerously-skip-permissions`,
 * Claude Code's native permission prompts are bypassed. A PreToolUse hook is the only
 * layer that still runs and can block a tool call in that mode (settings.json
 * `permissions.deny` rules are honoured, but a hook is what we control here). This
 * module is the pure classifier behind that hook: given a Bash command string it
 * decides whether the command belongs to a destructive class and must be denied.
 *
 * Design rules:
 * - Robust against evasion: flag reordering, quoting, and command chaining
 *   (`&&`, `;`, `|`, `||`, newlines, subshells, command substitution) are all
 *   decomposed before matching, not pattern-matched on the raw string.
 * - Default-deny on ambiguity for the destructive classes — a command that looks
 *   like it could be one of the blocked classes is denied rather than allowed.
 * - Keep ordinary dev commands working: build, test, `git add`/`commit`, `gh pr`, etc.
 *
 * The classifier is intentionally standalone and side-effect free so it can be unit
 * tested exhaustively.
 */

export type CommandGuardDecision = "allow" | "deny";

export interface CommandGuardVerdict {
	decision: CommandGuardDecision;
	/** Human-readable explanation, present when `decision === "deny"`. */
	reason?: string;
	/** Stable machine id of the matched rule, for tests and telemetry. */
	rule?: string;
}

export interface CommandGuardOptions {
	/**
	 * Absolute path of the task's worktree. When provided, writes/deletes that target
	 * an absolute path outside this tree are denied. When omitted the guard still
	 * blocks the always-dangerous classes (device writes, sensitive system dirs, etc.).
	 */
	worktreePath?: string;
}

const ALLOW: CommandGuardVerdict = { decision: "allow" };

function deny(rule: string, reason: string): CommandGuardVerdict {
	return { decision: "deny", rule, reason };
}

/** Interpreters that must never be fed piped network output. */
const SHELL_INTERPRETERS = [
	"sh",
	"bash",
	"zsh",
	"dash",
	"ksh",
	"fish",
	"csh",
	"tcsh",
	"python",
	"python2",
	"python3",
	"perl",
	"ruby",
	"node",
	"nodejs",
	"php",
	"pwsh",
	"powershell",
];

const NETWORK_FETCHERS = ["curl", "wget", "fetch", "http", "https", "lynx", "aria2c"];

/** Absolute prefixes that must never be written to, regardless of worktree. */
const SENSITIVE_WRITE_PREFIXES = [
	"/etc",
	"/usr",
	"/bin",
	"/sbin",
	"/boot",
	"/sys",
	"/proc",
	"/dev",
	"/System",
	"/Library",
	"/var/root",
];

/** Home-relative sensitive locations (matched after `~`/`$HOME` expansion markers). */
const SENSITIVE_HOME_SUBPATHS = [".ssh", ".aws", ".gnupg", ".config/gcloud", ".kube", ".docker/config.json"];

/** Device path prefixes whose being a redirect/`dd` target is destructive. */
const DEVICE_WRITE_PREFIXES = [
	"/dev/sd",
	"/dev/hd",
	"/dev/nvme",
	"/dev/disk",
	"/dev/rdisk",
	"/dev/mapper",
	"/dev/vd",
	"/dev/xvd",
	"/dev/mmcblk",
	"/dev/loop",
];

/** Redirect targets under /dev that are legitimate sinks. */
const SAFE_DEVICE_TARGETS = new Set([
	"/dev/null",
	"/dev/stdout",
	"/dev/stderr",
	"/dev/tty",
	"/dev/zero",
	"/dev/random",
	"/dev/urandom",
]);

interface ParsedCommand {
	/** Command word with any leading path stripped (e.g. `/bin/rm` -> `rm`). */
	name: string;
	/** All tokens including the command word and its arguments, minus redirections. */
	argv: string[];
	/** Redirection targets that this command writes to (`>`, `>>`, and `tee` args). */
	writeTargets: string[];
}

/**
 * Tokenize a shell command line into a flat list of simple commands. Chaining and
 * grouping operators (`&&`, `||`, `;`, `|`, `&`, newlines, subshells, command and
 * process substitution, backticks) all split the stream, so each blocked class is
 * evaluated on the individual command that would actually run — this is what defeats
 * `safe && rm -rf /` and `echo $(rm -rf /)` style evasion.
 */
function tokenizeCommands(input: string): ParsedCommand[] {
	const commands: ParsedCommand[] = [];
	let tokens: string[] = [];
	let redirects: string[] = [];
	let token = "";
	let hasToken = false;
	let pendingRedirect = false;
	let i = 0;

	const flushToken = (): void => {
		if (!hasToken) {
			return;
		}
		if (pendingRedirect) {
			redirects.push(token);
			pendingRedirect = false;
		} else {
			tokens.push(token);
		}
		token = "";
		hasToken = false;
	};

	const flushCommand = (): void => {
		flushToken();
		if (tokens.length > 0 || redirects.length > 0) {
			commands.push(buildParsedCommand(tokens, redirects));
		}
		tokens = [];
		redirects = [];
		pendingRedirect = false;
	};

	while (i < input.length) {
		const c = input[i];

		if (c === "'") {
			hasToken = true;
			i += 1;
			while (i < input.length && input[i] !== "'") {
				token += input[i];
				i += 1;
			}
			i += 1; // consume closing quote (tolerate missing close at EOF)
			continue;
		}

		if (c === '"') {
			hasToken = true;
			i += 1;
			while (i < input.length && input[i] !== '"') {
				if (input[i] === "\\" && i + 1 < input.length && '"\\$`\n'.includes(input[i + 1])) {
					if (input[i + 1] !== "\n") {
						token += input[i + 1];
					}
					i += 2;
					continue;
				}
				token += input[i];
				i += 1;
			}
			i += 1;
			continue;
		}

		if (c === "\\") {
			if (i + 1 < input.length) {
				if (input[i + 1] !== "\n") {
					token += input[i + 1];
					hasToken = true;
				}
				i += 2;
				continue;
			}
			i += 1;
			continue;
		}

		// Command / grouping separators — each starts a fresh simple command.
		if (c === ";" || c === "\n" || c === "&" || c === "|") {
			flushCommand();
			if ((c === "&" || c === "|") && input[i + 1] === c) {
				i += 1;
			}
			i += 1;
			continue;
		}
		if (c === "(" || c === ")" || c === "{" || c === "}" || c === "`") {
			flushCommand();
			i += 1;
			continue;
		}
		if (c === "$" && input[i + 1] === "(") {
			flushCommand();
			i += 2;
			continue;
		}

		if (c === ">" || c === "<") {
			flushToken();
			// Consume the operator (>, >>, <, <<, >&, and optional leading fd digit already tokenized).
			i += 1;
			let isWrite = c === ">";
			if (input[i] === c) {
				i += 1; // >> or <<
			}
			if (input[i] === "&") {
				i += 1;
				isWrite = false; // fd duplication like 2>&1, not a file target
			}
			pendingRedirect = isWrite;
			continue;
		}

		if (c === " " || c === "\t" || c === "\r") {
			flushToken();
			i += 1;
			continue;
		}

		token += c;
		hasToken = true;
		i += 1;
	}

	flushCommand();
	return commands;
}

/**
 * Wrapper commands that run another command — `env FOO=1 rm -rf /`, `command rm …`,
 * `xargs rm -rf`, `nohup dd …`. The real command must be unwrapped so its rule fires;
 * otherwise the wrapper name would shadow it. `sudo`/`doas`/`su` are intentionally NOT
 * unwrapped — they are blocked outright as privilege escalation.
 */
const WRAPPER_COMMANDS = new Set([
	"env",
	"command",
	"builtin",
	"exec",
	"nohup",
	"nice",
	"ionice",
	"setsid",
	"stdbuf",
	"time",
	"xargs",
	"timeout",
]);

/** Wrapper flags that consume the following token as their value (so we skip both). */
const WRAPPER_VALUE_FLAGS = new Set([
	"-u",
	"-C",
	"-S",
	"-n",
	"-P",
	"-I",
	"-L",
	"-s",
	"-d",
	"-E",
	"-a",
	"-i",
	"-o",
	"-e",
	"-c",
	"-k",
	"--signal",
]);

function stripEnvAssignments(tokens: string[]): string[] {
	let start = 0;
	while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start])) {
		start += 1;
	}
	return tokens.slice(start);
}

/** Peel wrapper prefixes (and their assignments/options) until the real command word. */
function unwrapCommand(tokens: string[]): string[] {
	let argv = stripEnvAssignments(tokens);
	// Bounded loop: each pass strips at least the wrapper word, so it always terminates.
	for (let guard = 0; guard < tokens.length && argv.length > 0; guard += 1) {
		const word = basename(argv[0]);
		if (!WRAPPER_COMMANDS.has(word)) {
			break;
		}
		let i = 1;
		while (i < argv.length) {
			const token = argv[i];
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
				i += 1;
				continue;
			}
			if (token === "--") {
				i += 1;
				break;
			}
			if (token.startsWith("-")) {
				i += WRAPPER_VALUE_FLAGS.has(token) ? 2 : 1;
				continue;
			}
			break;
		}
		// `timeout DURATION COMMAND …` — the first positional is the duration, not the command.
		if (word === "timeout" && i < argv.length && !argv[i].startsWith("-")) {
			i += 1;
		}
		argv = stripEnvAssignments(argv.slice(i));
	}
	return argv;
}

function buildParsedCommand(rawTokens: string[], redirects: string[]): ParsedCommand {
	const argv = unwrapCommand(rawTokens);
	const name = basename(argv[0] ?? "");
	const writeTargets = [...redirects];
	return { name, argv, writeTargets };
}

function basename(commandWord: string): string {
	if (!commandWord) {
		return "";
	}
	const normalized = commandWord.replaceAll("\\", "/");
	const parts = normalized.split("/");
	return parts[parts.length - 1] ?? "";
}

function isFlag(token: string): boolean {
	return token.startsWith("-") && token !== "-" && token !== "--";
}

/** Split bundled short flags like `-rf` into `r`, `f`; long flags pass through as a whole. */
function shortFlagChars(token: string): string[] {
	if (!token.startsWith("-") || token.startsWith("--")) {
		return [];
	}
	return token.slice(1).split("");
}

function positionalArgs(argv: string[]): string[] {
	// argv[0] is the command word; skip flags and flag values we don't model.
	return argv.slice(1).filter((arg) => !arg.startsWith("-"));
}

function looksAbsolute(path: string): boolean {
	return path.startsWith("/");
}

function referencesHome(path: string): boolean {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: matching the literal shell token ${HOME}, not a JS template.
	const bracedHome = "${HOME}";
	return path === "~" || path.startsWith("~/") || path.includes("$HOME") || path.includes(bracedHome);
}

function targetsFilesystemRoot(path: string): boolean {
	const stripped = stripQuotes(path);
	if (stripped === "/" || stripped === "/*") {
		return true;
	}
	// `/.` `/..` and root-level globs.
	return /^\/[.*]?$/.test(stripped);
}

function stripQuotes(value: string): string {
	return value.replaceAll("'", "").replaceAll('"', "");
}

function normalizePath(path: string): string {
	return stripQuotes(path);
}

function isUnderWorktree(path: string, worktreePath: string): boolean {
	const target = normalizePath(path);
	const root = worktreePath.replace(/\/+$/, "");
	return target === root || target.startsWith(`${root}/`);
}

function isSensitiveWriteTarget(rawPath: string): boolean {
	const path = normalizePath(rawPath);
	if (referencesHome(path)) {
		const homeRelative = path.replace(/^~\/?/, "").replace(/\$\{?HOME\}?\/?/, "");
		if (SENSITIVE_HOME_SUBPATHS.some((sub) => homeRelative === sub || homeRelative.startsWith(`${sub}/`))) {
			return true;
		}
	}
	return SENSITIVE_WRITE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function isDeviceWriteTarget(rawPath: string): boolean {
	const path = normalizePath(rawPath);
	if (SAFE_DEVICE_TARGETS.has(path)) {
		return false;
	}
	return DEVICE_WRITE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Detect a network-fetch piped or substituted into an interpreter
 * (`curl … | sh`, `wget … | sudo bash`, `bash <(curl …)`, `sh -c "$(curl …)"`).
 * Operates on the whole command line because the danger is the data flow between
 * two commands, not either command alone.
 */
function hasRemoteExecPipeline(input: string): boolean {
	const fetchers = NETWORK_FETCHERS.join("|");
	const interpreters = SHELL_INTERPRETERS.join("|");
	// fetcher ... | [sudo] interpreter
	const pipeToShell = new RegExp(
		`\\b(?:${fetchers})\\b[^|]*\\|\\s*(?:sudo\\s+|env\\s+[^|]*)?(?:${interpreters})\\b`,
		"i",
	);
	// interpreter reading from <(fetcher …) or $(fetcher …) or `fetcher …`
	const substitutedIntoShell = new RegExp(
		`\\b(?:${interpreters})\\b[^\\n]*(?:<\\(|\\$\\(|\`)\\s*(?:sudo\\s+)?(?:${fetchers})\\b`,
		"i",
	);
	return pipeToShell.test(input) || substitutedIntoShell.test(input);
}

/** Classic fork bomb and close variants (`:(){ :|:& };:`). */
function isForkBomb(input: string): boolean {
	const collapsed = input.replace(/\s+/g, "");
	// A function whose body pipes itself into a backgrounded copy of itself.
	return /([A-Za-z_:][A-Za-z0-9_:]*)\(\)\{[^}]*\1\s*\|[^}]*\1[^}]*&[^}]*\}\s*;?\s*\1/.test(collapsed);
}

function evaluateRm(cmd: ParsedCommand, options: CommandGuardOptions): CommandGuardVerdict | null {
	if (cmd.name !== "rm") {
		return null;
	}
	const flags = cmd.argv.slice(1).filter(isFlag);
	const chars = flags.flatMap(shortFlagChars);
	const targets = positionalArgs(cmd.argv).map(normalizePath);

	if (chars.includes("r") || chars.includes("R") || flags.includes("--recursive")) {
		return deny("rm-recursive", "Recursive delete (rm -r) is blocked for unattended weak-model agents.");
	}
	for (const target of targets) {
		if (targetsFilesystemRoot(target)) {
			return deny("rm-root", "Deleting the filesystem root is blocked.");
		}
		if (referencesHome(target)) {
			return deny("rm-home", "Deleting the home directory is blocked.");
		}
		if (isSensitiveWriteTarget(target)) {
			return deny("rm-sensitive", `Deleting a sensitive system/credential path is blocked: ${target}`);
		}
		if (looksAbsolute(target) && options.worktreePath && !isUnderWorktree(target, options.worktreePath)) {
			return deny("rm-outside-worktree", `Deleting a path outside the task worktree is blocked: ${target}`);
		}
	}
	// A bare `rm -f` with no target, or targeting relative in-worktree paths, is allowed.
	return null;
}

function evaluateDiskDestroyers(cmd: ParsedCommand): CommandGuardVerdict | null {
	if (cmd.name === "dd") {
		const writesDevice = cmd.argv.some((arg) => {
			const match = /^of=(.+)$/.exec(stripQuotes(arg));
			return match ? isDeviceWriteTarget(match[1]) : false;
		});
		if (writesDevice) {
			return deny("dd-device", "dd writing to a block device is blocked.");
		}
		return deny("dd", "dd is blocked for unattended weak-model agents (raw disk/file overwrite risk).");
	}
	if (cmd.name.startsWith("mkfs")) {
		return deny("mkfs", "Filesystem creation (mkfs) is blocked.");
	}
	if (cmd.name === "shred") {
		return deny("shred", "shred is blocked (irreversible data destruction).");
	}
	if (cmd.name === "fdisk" || cmd.name === "parted" || cmd.name === "wipefs" || cmd.name === "blkdiscard") {
		return deny("disk-tool", `${cmd.name} is blocked (partition/disk manipulation).`);
	}
	return null;
}

/** A chmod mode that grants write/all access to "others" (world) — the dangerous class. */
function isPermissiveMode(mode: string): boolean {
	const m = stripQuotes(mode).trim();
	if (/^[0-7]{3,4}$/.test(m)) {
		const others = m[m.length - 1];
		return "2367".includes(others);
	}
	// Symbolic: granting others/all any of write/execute (e.g. a+rwx, o+w, a=rwx).
	return /(?:^|,)[ao][+=][^,]*[wx]/.test(m);
}

function evaluatePrivilege(cmd: ParsedCommand): CommandGuardVerdict | null {
	if (cmd.name === "sudo" || cmd.name === "doas" || cmd.name === "su") {
		return deny("privilege-escalation", `${cmd.name} (privilege escalation) is blocked.`);
	}
	if (cmd.name === "chmod") {
		const flags = cmd.argv.slice(1).filter(isFlag);
		const recursive = flags.some((f) => shortFlagChars(f).includes("R") || f === "--recursive");
		const mode = positionalArgs(cmd.argv)[0] ?? "";
		if (recursive && isPermissiveMode(mode)) {
			return deny("chmod-recursive-world", "Recursive world-writable chmod (e.g. chmod -R 777) is blocked.");
		}
	}
	if (cmd.name === "chown") {
		const flags = cmd.argv.slice(1).filter(isFlag);
		const recursive = flags.some((f) => shortFlagChars(f).includes("R") || f === "--recursive");
		if (recursive) {
			const targets = positionalArgs(cmd.argv).slice(1); // first positional is owner spec
			if (
				targets.some(
					(t) => targetsFilesystemRoot(t) || referencesHome(t) || (looksAbsolute(t) && !t.startsWith("/tmp/")),
				)
			) {
				return deny("chown-recursive-broad", "Recursive chown on a broad/absolute path is blocked.");
			}
		}
	}
	return null;
}

function evaluateGit(cmd: ParsedCommand): CommandGuardVerdict | null {
	if (cmd.name !== "git") {
		return null;
	}
	// Find the git subcommand, skipping global options like `-C <path>` / `-c k=v`.
	const args = cmd.argv.slice(1);
	let subIndex = 0;
	let workingDirOverride: string | null = null;
	while (subIndex < args.length) {
		const arg = args[subIndex];
		if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree") {
			if (arg === "-C") {
				workingDirOverride = args[subIndex + 1] ?? null;
			}
			subIndex += 2;
			continue;
		}
		if (arg.startsWith("-")) {
			subIndex += 1;
			continue;
		}
		break;
	}
	const sub = args[subIndex];
	const rest = args.slice(subIndex + 1);

	if (sub === "push") {
		if (rest.some((a) => stripQuotes(a) === "upstream")) {
			return deny("git-push-upstream", "Pushing to the 'upstream' remote is blocked.");
		}
		const force = rest.some(
			(a) =>
				a === "--force" ||
				a === "-f" ||
				(a.startsWith("-") && !a.startsWith("--") && shortFlagChars(a).includes("f")),
		);
		const forceWithLease = rest.some((a) => a === "--force-with-lease" || a.startsWith("--force-with-lease="));
		if (force && !forceWithLease) {
			const protectedRef = rest.some((a) =>
				["main", "master", "develop", "development", "release"].includes(stripQuotes(a)),
			);
			if (protectedRef) {
				return deny(
					"git-push-force-protected",
					"Force-pushing to a protected branch (main/master/develop) is blocked.",
				);
			}
		}
		if (rest.some((a) => a === "--mirror")) {
			return deny("git-push-mirror", "git push --mirror is blocked.");
		}
	}

	if (sub === "reset" && rest.some((a) => a === "--hard")) {
		if (workingDirOverride && looksAbsolute(workingDirOverride)) {
			return deny("git-reset-hard-foreign", "git reset --hard against another repo path is blocked.");
		}
	}

	if (sub === "clean") {
		const flags = rest.filter(isFlag);
		const chars = flags.flatMap(shortFlagChars);
		const force = chars.includes("f") || flags.includes("--force");
		if (force && (chars.includes("x") || chars.includes("X"))) {
			return deny(
				"git-clean-ignored",
				"git clean removing ignored files (-x/-X) is blocked (nukes .env, node_modules, etc.).",
			);
		}
	}

	return null;
}

function isBroadPath(path: string, options: CommandGuardOptions): boolean {
	const target = normalizePath(path);
	if (targetsFilesystemRoot(target) || referencesHome(target)) {
		return true;
	}
	if (!looksAbsolute(target)) {
		return false;
	}
	if (options.worktreePath) {
		return !isUnderWorktree(target, options.worktreePath) && !target.startsWith("/tmp/");
	}
	return isSensitiveWriteTarget(target);
}

function evaluateFind(cmd: ParsedCommand, options: CommandGuardOptions): CommandGuardVerdict | null {
	if (cmd.name !== "find") {
		return null;
	}
	const args = cmd.argv.slice(1);
	// Search roots are the leading non-flag tokens before the first predicate.
	const roots: string[] = [];
	for (const arg of args) {
		if (arg.startsWith("-") || arg === "(" || arg === "!") {
			break;
		}
		roots.push(arg);
	}

	if (args.includes("-delete") && roots.some((root) => isBroadPath(root, options))) {
		return deny("find-delete-broad", "find -delete over a broad/outside-worktree path is blocked.");
	}

	const execIndex = args.findIndex(
		(arg) => arg === "-exec" || arg === "-execdir" || arg === "-ok" || arg === "-okdir",
	);
	if (execIndex >= 0) {
		const execArgv = args.slice(execIndex + 1).filter((token) => token !== "{}" && token !== ";" && token !== "+");
		if (execArgv.length > 0) {
			const execCommand = buildParsedCommand(execArgv, []);
			const nested =
				evaluateRm(execCommand, options) ?? evaluateDiskDestroyers(execCommand) ?? evaluatePrivilege(execCommand);
			if (nested) {
				return deny(
					nested.rule ?? "find-exec-destructive",
					`find -exec of a destructive command is blocked: ${nested.reason ?? ""}`.trim(),
				);
			}
		}
	}
	return null;
}

function evaluateWriteTargets(cmd: ParsedCommand, options: CommandGuardOptions): CommandGuardVerdict | null {
	const targets = [...cmd.writeTargets];
	if (cmd.name === "tee") {
		targets.push(...positionalArgs(cmd.argv));
	}
	for (const rawTarget of targets) {
		const target = normalizePath(rawTarget);
		if (SAFE_DEVICE_TARGETS.has(target)) {
			continue; // /dev/null, /dev/stderr, /dev/tty, … are legitimate sinks.
		}
		if (isDeviceWriteTarget(target)) {
			return deny("write-device", `Writing to a block device is blocked: ${target}`);
		}
		if (isSensitiveWriteTarget(target)) {
			return deny("write-sensitive", `Writing to a sensitive system/credential path is blocked: ${target}`);
		}
		if (
			looksAbsolute(target) &&
			options.worktreePath &&
			!isUnderWorktree(target, options.worktreePath) &&
			!target.startsWith("/tmp/") &&
			!target.startsWith("/private/tmp/")
		) {
			return deny("write-outside-worktree", `Writing outside the task worktree is blocked: ${target}`);
		}
	}
	return null;
}

/**
 * Classify a Bash command. Returns an `allow`/`deny` verdict; on `deny` the reason is
 * safe to surface back to the agent so it can adjust.
 */
export function evaluateBashCommand(command: string, options: CommandGuardOptions = {}): CommandGuardVerdict {
	const input = command ?? "";
	if (!input.trim()) {
		return ALLOW;
	}

	if (isForkBomb(input)) {
		return deny("fork-bomb", "Fork bomb pattern is blocked.");
	}
	if (hasRemoteExecPipeline(input)) {
		return deny("remote-exec", "Piping network downloads into a shell interpreter is blocked.");
	}

	const commands = tokenizeCommands(input);
	for (const cmd of commands) {
		if (!cmd.name) {
			continue;
		}
		const verdict =
			evaluateRm(cmd, options) ??
			evaluateDiskDestroyers(cmd) ??
			evaluatePrivilege(cmd) ??
			evaluateGit(cmd) ??
			evaluateFind(cmd, options) ??
			evaluateWriteTargets(cmd, options);
		if (verdict) {
			return verdict;
		}
	}

	return ALLOW;
}
