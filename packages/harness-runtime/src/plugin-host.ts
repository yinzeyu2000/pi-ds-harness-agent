import { ServiceConflictError, ServiceScope, type ServiceToken } from "./services.ts";

export interface Disposable {
	dispose(): void | Promise<void>;
}

export interface PluginManifest {
	id: string;
	version: string;
	provides?: readonly ServiceToken<unknown>[];
	requires?: readonly ServiceToken<unknown>[];
	optional?: readonly ServiceToken<unknown>[];
}

export interface HarnessPlugin<TConfig = unknown> {
	manifest: PluginManifest;
	activate(
		context: PluginContext,
		config: TConfig,
	): void | Disposable | (() => void | Promise<void>) | Promise<void | Disposable | (() => void | Promise<void>)>;
}

export interface PluginSpec<TConfig = unknown> {
	plugin: HarnessPlugin<TConfig>;
	config: TConfig;
}

export interface PluginContext {
	readonly pluginId: string;
	readonly signal: AbortSignal;
	provide<T>(token: ServiceToken<T>, value: T): Disposable;
	require<T>(token: ServiceToken<T>): T;
	get<T>(token: ServiceToken<T>): T | undefined;
	effect(
		setup: () =>
			| void
			| Disposable
			| (() => void | Promise<void>)
			| Promise<void | Disposable | (() => void | Promise<void>)>,
	): Promise<Disposable>;
}

export class PluginDependencyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PluginDependencyError";
	}
}

export class PluginActivationError extends Error {
	readonly pluginId: string;

	constructor(pluginId: string, cause: unknown) {
		super(`Plugin activation failed: ${pluginId}`, { cause });
		this.name = "PluginActivationError";
		this.pluginId = pluginId;
	}
}

function toDisposer(value: void | Disposable | (() => void | Promise<void>)): () => void | Promise<void> {
	if (typeof value === "function") return value;
	if (value) return () => value.dispose();
	return () => {};
}

class EffectScope {
	private readonly abortController = new AbortController();
	private readonly disposers: Array<() => void | Promise<void>> = [];
	private disposed = false;

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	async effect(
		setup: () =>
			| void
			| Disposable
			| (() => void | Promise<void>)
			| Promise<void | Disposable | (() => void | Promise<void>)>,
	): Promise<Disposable> {
		if (this.disposed) throw new Error("Plugin scope is already disposed");
		return this.add(toDisposer(await setup()));
	}

	add(disposer: () => void | Promise<void>): Disposable {
		if (this.disposed) throw new Error("Plugin scope is already disposed");
		let active = true;
		const registration = async () => {
			if (!active) return;
			active = false;
			await disposer();
		};
		this.disposers.push(registration);
		return { dispose: registration };
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.abortController.abort();
		const errors: unknown[] = [];
		for (let index = this.disposers.length - 1; index >= 0; index--) {
			try {
				await this.disposers[index]!();
			} catch (error) {
				errors.push(error);
			}
		}
		this.disposers.length = 0;
		if (errors.length > 0) throw new AggregateError(errors, "One or more plugin effects failed to dispose");
	}
}

interface ActivatedPlugin {
	id: string;
	scope: EffectScope;
}

export class PluginHost {
	private readonly services = new ServiceScope();
	private readonly activated: ActivatedPlugin[] = [];
	private started = false;

	async start(specs: readonly PluginSpec[]): Promise<void> {
		if (this.started) throw new Error("Plugin host has already started");
		const ordered = resolvePluginOrder(specs);
		this.started = true;
		try {
			for (const spec of ordered) await this.activate(spec);
		} catch (error) {
			try {
				await this.stop();
			} catch (disposeError) {
				throw new AggregateError([error, disposeError], "Plugin activation and rollback both failed");
			}
			throw error;
		}
	}

	get<T>(token: ServiceToken<T>): T | undefined {
		return this.services.get(token);
	}

	require<T>(token: ServiceToken<T>): T {
		return this.services.require(token);
	}

	async stop(): Promise<void> {
		const errors: unknown[] = [];
		for (let index = this.activated.length - 1; index >= 0; index--) {
			try {
				await this.activated[index]!.scope.dispose();
			} catch (error) {
				errors.push(error);
			}
		}
		this.activated.length = 0;
		this.started = false;
		if (errors.length > 0) throw new AggregateError(errors, "Plugin host shutdown failed");
	}

	get activePluginCount(): number {
		return this.activated.length;
	}

	get serviceCount(): number {
		return this.services.localServiceCount;
	}

	private async activate(spec: PluginSpec): Promise<void> {
		const { manifest } = spec.plugin;
		const scope = new EffectScope();
		const declaredProvides = new Set((manifest.provides ?? []).map((token) => token.id));
		const context: PluginContext = {
			pluginId: manifest.id,
			signal: scope.signal,
			provide: <T>(token: ServiceToken<T>, value: T): Disposable => {
				if (!declaredProvides.has(token.id)) {
					throw new PluginDependencyError(`Plugin ${manifest.id} provided undeclared service ${token.id}`);
				}
				const unregister = this.services.provide(token, value);
				scope.add(unregister);
				return { dispose: unregister };
			},
			require: <T>(token: ServiceToken<T>) => this.services.require(token),
			get: <T>(token: ServiceToken<T>) => this.services.get(token),
			effect: (setup) => scope.effect(setup),
		};

		try {
			const pluginDisposer = await spec.plugin.activate(context, spec.config);
			if (pluginDisposer) await scope.effect(() => pluginDisposer);
			this.activated.push({ id: manifest.id, scope });
		} catch (error) {
			try {
				await scope.dispose();
			} catch (disposeError) {
				throw new PluginActivationError(manifest.id, new AggregateError([error, disposeError]));
			}
			throw new PluginActivationError(manifest.id, error);
		}
	}
}

export function resolvePluginOrder(specs: readonly PluginSpec[]): PluginSpec[] {
	const byId = new Map<string, PluginSpec>();
	const providerByToken = new Map<string, string>();
	for (const spec of specs) {
		const { manifest } = spec.plugin;
		if (byId.has(manifest.id)) throw new PluginDependencyError(`Duplicate plugin id: ${manifest.id}`);
		byId.set(manifest.id, spec);
		for (const token of manifest.provides ?? []) {
			const existing = providerByToken.get(token.id);
			if (existing) throw new ServiceConflictError(token.id);
			providerByToken.set(token.id, manifest.id);
		}
	}

	const dependencies = new Map<string, Set<string>>();
	for (const spec of specs) {
		const id = spec.plugin.manifest.id;
		const required = new Set<string>();
		for (const token of spec.plugin.manifest.requires ?? []) {
			const provider = providerByToken.get(token.id);
			if (!provider) throw new PluginDependencyError(`Plugin ${id} requires missing service ${token.id}`);
			if (provider !== id) required.add(provider);
		}
		for (const token of spec.plugin.manifest.optional ?? []) {
			const provider = providerByToken.get(token.id);
			if (provider && provider !== id) required.add(provider);
		}
		dependencies.set(id, required);
	}

	const result: PluginSpec[] = [];
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string, path: string[]): void => {
		if (visited.has(id)) return;
		if (visiting.has(id)) throw new PluginDependencyError(`Plugin dependency cycle: ${[...path, id].join(" -> ")}`);
		visiting.add(id);
		for (const dependency of dependencies.get(id) ?? []) visit(dependency, [...path, id]);
		visiting.delete(id);
		visited.add(id);
		result.push(byId.get(id)!);
	};
	for (const spec of specs) visit(spec.plugin.manifest.id, []);
	return result;
}
