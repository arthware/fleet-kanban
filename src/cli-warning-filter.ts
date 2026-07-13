type EmitWarning = typeof process.emitWarning;

export function shouldSuppressModuleRegisterDeprecationWarning(
	warning: string | Error,
	typeOrOptions?: string | NodeJS.EmitWarningOptions,
	code?: string,
): boolean {
	const warningCode =
		typeof typeOrOptions === "object" && typeOrOptions !== null ? typeOrOptions.code : (code ?? undefined);
	const message = typeof warning === "string" ? warning : warning.message;
	return warningCode === "DEP0205" && message.includes("module.register()");
}

export function installModuleRegisterDeprecationWarningFilter(): void {
	const originalEmitWarning = process.emitWarning.bind(process) as EmitWarning;
	process.emitWarning = ((
		warning: string | Error,
		typeOrOptions?: string | NodeJS.EmitWarningOptions,
		code?: string,
	) => {
		// tsx's ESM loader still calls module.register(), which is noisy on Node 22.
		// Keep every other warning visible so stderr remains useful for callers.
		if (shouldSuppressModuleRegisterDeprecationWarning(warning, typeOrOptions, code)) {
			return;
		}
		return originalEmitWarning(warning, typeOrOptions as string, code);
	}) as EmitWarning;
}

installModuleRegisterDeprecationWarningFilter();
