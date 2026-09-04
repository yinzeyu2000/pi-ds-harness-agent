declare const serviceTokenBrand: unique symbol;

export interface ServiceToken<T> {
	readonly id: string;
	readonly [serviceTokenBrand]: T;
}

export function createServiceToken<T>(id: string): ServiceToken<T> {
	if (!id || typeof id !== "string" || id.trim().length === 0) {
		throw new TypeError("Service token id must be a non-empty string");
	}
	return Object.freeze({ id }) as ServiceToken<T>;
}
