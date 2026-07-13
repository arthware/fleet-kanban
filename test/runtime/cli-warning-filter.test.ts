import { afterEach, describe, expect, it } from "vitest";

import { installModuleRegisterDeprecationWarningFilter } from "../../src/cli-warning-filter";

const originalEmitWarning = process.emitWarning;

afterEach(() => {
	process.emitWarning = originalEmitWarning;
});

function installFilterWithCapturedWarnings(): Array<{
	warning: string | Error;
	typeOrOptions?: string | NodeJS.EmitWarningOptions;
	code?: string;
}> {
	const passedWarnings: Array<{
		warning: string | Error;
		typeOrOptions?: string | NodeJS.EmitWarningOptions;
		code?: string;
	}> = [];
	process.emitWarning = ((
		warning: string | Error,
		typeOrOptions?: string | NodeJS.EmitWarningOptions,
		code?: string,
	) => {
		passedWarnings.push({ warning, typeOrOptions, code });
	}) as typeof process.emitWarning;
	installModuleRegisterDeprecationWarningFilter();
	return passedWarnings;
}

describe("emitWarning filter", () => {
	it("given the emitWarning filter, when a DEP0205 module.register warning is emitted, then it is suppressed", () => {
		// given
		const passedWarnings = installFilterWithCapturedWarnings();

		// when
		process.emitWarning("`module.register()` is deprecated. Use `module.registerHooks()` instead.", {
			type: "DeprecationWarning",
			code: "DEP0205",
		});

		// then
		expect(passedWarnings).toEqual([]);
	});

	it("given the emitWarning filter, when any other warning is emitted, then it passes through", () => {
		// given
		const passedWarnings = installFilterWithCapturedWarnings();

		// when
		process.emitWarning("A different warning", {
			type: "DeprecationWarning",
			code: "DEP9999",
		});

		// then
		expect(passedWarnings).toEqual([
			{
				warning: "A different warning",
				typeOrOptions: {
					type: "DeprecationWarning",
					code: "DEP9999",
				},
				code: undefined,
			},
		]);
	});
});
