import type { Effect } from "./context.ts";
import type { ServiceToken } from "./tokens.ts";

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

interface Registration {
	readonly id: symbol;
	readonly value: unknown;
}

export class ServiceScope {
	readonly name: string;
	readonly parent?: ServiceScope;
	private readonly services = new Map<string, Registration>();

	constructor(name = "root", parent?: ServiceScope) {
		this.name = name;
		this.parent = parent;
	}

	provide<T>(token: ServiceToken<T>, value: T): Effect {
		if (this.services.has(token.id)) {
			throw new ServiceConflictError(token.id);
		}
		const reg: Registration = { id: Symbol(token.id), value };
		this.services.set(token.id, reg);
		let disposed = false;
		return {
			dispose: () => {
				if (disposed) return;
				disposed = true;
				if (this.services.get(token.id)?.id === reg.id) {
					this.services.delete(token.id);
				}
			},
		};
	}

	get<T>(token: ServiceToken<T>): T | undefined {
		const local = this.services.get(token.id);
		if (local !== undefined) {
			return local.value as T;
		}
		return this.parent?.get(token);
	}

	require<T>(token: ServiceToken<T>): T {
		const value = this.get(token);
		if (value === undefined) {
			throw new ServiceNotFoundError(token.id);
		}
		return value;
	}

	hasLocal(token: ServiceToken<unknown>): boolean {
		return this.services.has(token.id);
	}

	createChild(name: string): ServiceScope {
		return new ServiceScope(name, this);
	}

	get serviceCount(): number {
		return this.services.size;
	}
}
