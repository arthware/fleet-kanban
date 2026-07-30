export type Capability<T> =
	| { readonly supported: true; readonly value: T }
	| { readonly supported: false; readonly reason: string };

export function supported<T>(value: T): Capability<T> {
	return { supported: true, value };
}

export function unsupported<T = never>(reason: string): Capability<T> {
	return { supported: false, reason };
}
