import { homedir } from "node:os";
import { join } from "node:path";

export function getCodexSessionsRoot(homePath: string = homedir()): string {
	return join(homePath, ".codex", "sessions");
}
