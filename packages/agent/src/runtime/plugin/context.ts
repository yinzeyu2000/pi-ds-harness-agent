import type { PluginManifest } from "./manifest.ts";
import type { ServiceToken } from "./tokens.ts";

export interface Effect {
	dispose(): void | Promise<void>;
}

declare const eventTokenBrand: unique symbol;

export interface EventToken<T> {
	readonly id: string;
	readonly [eventTokenBrand]?: T;
}

export interface ManagedTask<T> {
	readonly promise: Promise<T>;
	abort(): void;
}

export interface PluginContext {
	readonly pluginId: string;
	readonly signal: AbortSignal;

	defer(disposer: () => void | Promise<void>): void;
	use<T>(resource: T, disposer: (resource: T) => void | Promise<void>): T;
	listen<T>(event: EventToken<T>, listener: (event: T) => void): Effect;
	task<T>(run: (signal: AbortSignal) => Promise<T>): ManagedTask<T>;
	timer(ms: number, callback: () => void | Promise<void>): Effect;
	provide<T>(token: ServiceToken<T>, value: T): Effect;
	require<T>(token: ServiceToken<T>): T;
	get<T>(token: ServiceToken<T>): T | undefined;
}

export interface Plugin {
	readonly manifest: PluginManifest;
	activate(context: PluginContext): void | Promise<void>;
}

export function createEventToken<T>(id: string): EventToken<T> {
	if (!id || typeof id !== "string" || id.trim().length === 0) {
		throw new TypeError("Event token id must be a non-empty string");
	}
	return Object.freeze({ id });
}
