export function hasCliOption(args: readonly string[], optionName: string): boolean {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === optionName || arg.startsWith(`${optionName}=`)) {
			return true;
		}
	}
	return false;
}

export function withPrompt(
	args: readonly string[],
	prompt: string,
	mode: "append" | "flag",
	flag?: string,
): readonly string[] {
	const trimmed = prompt.trim();
	if (!trimmed) {
		return args;
	}
	const result = [...args];
	if (mode === "flag" && flag) {
		result.push(flag, trimmed);
	} else {
		result.push(trimmed);
	}
	return result;
}
