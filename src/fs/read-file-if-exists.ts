import { readFile } from "node:fs/promises";

/** Read a UTF-8 file's contents, or null when it does not exist (ENOENT). */
export async function readFileIfExists(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
}
