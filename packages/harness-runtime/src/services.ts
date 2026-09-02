const serviceTokenBrand: unique symbol = Symbol("pi-ds.service-token");

export interface ServiceToken<T> {
	readonly id: string;
	readonly [serviceTokenBrand]: T;
}

export function createServiceToken<T>(id: string): ServiceToken<T> {
	if (id.trim().length === 0) throw new Error("Service token id must not be empty");
	return Object.freeze({ id }) as ServiceToken<T>;
}

export class ServiceNotFoundError extends Error {
	readonly tokenId: string;

	constructor(tokenId: string) {
		super(`Required service is not available: ${tokenId}`);
		this.name = "ServiceNotFoundError";
		this.tokenId = tokenId;
	}
}

export class ServiceConflictError extends Error {
	readonly tokenId: string;

	constructor(tokenId: string) {
		super(`Service already has a provider in this scope: ${tokenId}`);
		this.name = "ServiceConflictError";
		this.tokenId = tokenId;
	}
}

interface ServiceRegistration {
	id: symbol;
	value: unknown;
}

export class ServiceScope {
	private readonly services = new Map<string, ServiceRegistration>();
	readonly parent?: ServiceScope;

	constructor(parent?: ServiceScope) {
		this.parent = parent;
	}

	provide<T>(token: ServiceToken<T>, value: T): () => void {
		if (this.services.has(token.id)) throw new ServiceConflictError(token.id);
		const registration: ServiceRegistration = { id: Symbol(token.id), value };
		this.services.set(token.id, registration);
		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			if (this.services.get(token.id)?.id === registration.id) this.services.delete(token.id);
		};
	}

	get<T>(token: ServiceToken<T>): T | undefined {
		const local = this.services.get(token.id);
		if (local) return local.value as T;
		return this.parent?.get(token);
	}

	require<T>(token: ServiceToken<T>): T {
		const value = this.get(token);
		if (value === undefined) throw new ServiceNotFoundError(token.id);
		return value;
	}

	hasLocal(token: ServiceToken<unknown>): boolean {
		return this.services.has(token.id);
	}

	get localServiceCount(): number {
		return this.services.size;
	}
}
