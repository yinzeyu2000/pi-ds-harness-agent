import type { Effect, EventToken, ManagedTask, Plugin, PluginContext } from "./context.ts";
import { EffectScope } from "./effect-scope.ts";
import { matchesSemver } from "./manifest.ts";
import { createRuntimeScope, type HierarchicalScope } from "./scopes.ts";
import { ServiceConflictError, type ServiceScope } from "./service-scope.ts";
import type { ServiceToken } from "./tokens.ts";

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

interface ActivatedPluginRecord {
	readonly id: string;
	readonly scope: EffectScope;
}

export class PluginHost {
	readonly scope: HierarchicalScope;
	private readonly activated: ActivatedPluginRecord[] = [];
	private started = false;

	constructor(rootScope?: HierarchicalScope) {
		this.scope = rootScope ?? createRuntimeScope();
	}

	get serviceScope(): ServiceScope {
		return this.scope.serviceScope;
	}

	get isStarted(): boolean {
		return this.started;
	}

	get activatedCount(): number {
		return this.activated.length;
	}

	async start(plugins: readonly Plugin[]): Promise<void> {
		if (this.started) {
			throw new Error("PluginHost has already started");
		}
		const ordered = resolvePluginOrder(plugins);
		this.started = true;

		for (const plugin of ordered) {
			try {
				await this.activatePlugin(plugin);
			} catch (error) {
				try {
					await this.stop();
				} catch (rollbackError) {
					throw new AggregateError(
						[error, rollbackError],
						`Plugin activation for ${plugin.manifest.id} failed and rollback also encountered errors`,
					);
				}
				throw error;
			}
		}
	}

	private async activatePlugin(plugin: Plugin): Promise<void> {
		const { manifest } = plugin;
		const scope = new EffectScope();
		const declaredProvides = new Set((manifest.provides ?? []).map((p) => p.id));

		const context: PluginContext = {
			pluginId: manifest.id,
			signal: scope.signal,
			defer: (disposer) => {
				scope.add(disposer);
			},
			use: <T>(resource: T, disposer: (r: T) => void | Promise<void>): T => {
				scope.add(() => disposer(resource));
				return resource;
			},
			listen: <T>(_event: EventToken<T>, _listener: (e: T) => void): Effect => {
				const dummyDisposer = () => {};
				return scope.add(dummyDisposer);
			},
			task: <T>(run: (signal: AbortSignal) => Promise<T>): ManagedTask<T> => {
				const taskController = new AbortController();
				const combinedSignal = AbortSignal.any([scope.signal, taskController.signal]);
				const promise = run(combinedSignal);
				return {
					promise,
					abort: () => taskController.abort(),
				};
			},
			timer: (ms: number, callback: () => void | Promise<void>): Effect => {
				const timerId = setTimeout(() => {
					void callback();
				}, ms);
				return scope.add(() => {
					clearTimeout(timerId);
				});
			},
			provide: <T>(token: ServiceToken<T>, value: T): Effect => {
				if (!declaredProvides.has(token.id)) {
					throw new PluginDependencyError(
						`Plugin ${manifest.id} attempted to provide undeclared service ${token.id}`,
					);
				}
				const effect = this.scope.serviceScope.provide(token, value);
				scope.add(() => effect.dispose());
				return effect;
			},
			require: <T>(token: ServiceToken<T>): T => {
				return this.scope.serviceScope.require(token);
			},
			get: <T>(token: ServiceToken<T>): T | undefined => {
				return this.scope.serviceScope.get(token);
			},
		};

		try {
			await plugin.activate(context);
			this.activated.push({ id: manifest.id, scope });
		} catch (err) {
			await scope.dispose();
			throw new PluginActivationError(manifest.id, err);
		}
	}

	async stop(): Promise<void> {
		const errors: unknown[] = [];
		for (let i = this.activated.length - 1; i >= 0; i--) {
			try {
				await this.activated[i]!.scope.dispose();
			} catch (err) {
				errors.push(err);
			}
		}
		this.activated.length = 0;
		this.started = false;

		try {
			await this.scope.dispose();
		} catch (err) {
			errors.push(err);
		}

		if (errors.length > 0) {
			if (errors.length === 1) {
				throw errors[0];
			}
			throw new AggregateError(errors, "PluginHost shutdown encountered errors");
		}
	}
}

export function resolvePluginOrder(plugins: readonly Plugin[]): Plugin[] {
	const byId = new Map<string, Plugin>();
	const providerByService = new Map<string, string>();

	for (const plugin of plugins) {
		const { manifest } = plugin;
		if (byId.has(manifest.id)) {
			throw new PluginDependencyError(`Duplicate plugin id: ${manifest.id}`);
		}
		byId.set(manifest.id, plugin);

		for (const prov of manifest.provides ?? []) {
			const existing = providerByService.get(prov.id);
			if (existing) {
				throw new ServiceConflictError(
					`Service ${prov.id} is provided by multiple plugins: ${existing} and ${manifest.id}`,
				);
			}
			providerByService.set(prov.id, manifest.id);
		}
	}

	const dependencies = new Map<string, Set<string>>();
	for (const plugin of plugins) {
		const id = plugin.manifest.id;
		const required = new Set<string>();

		for (const req of plugin.manifest.requires ?? []) {
			const providerId = providerByService.get(req.id);
			if (!providerId) {
				throw new PluginDependencyError(`Plugin ${id} requires missing service ${req.id}`);
			}
			const providerPlugin = byId.get(providerId)!;
			const provEntry = providerPlugin.manifest.provides?.find((p) => p.id === req.id);
			const provVersion = provEntry?.version ?? providerPlugin.manifest.version;

			if (req.versionRange && !matchesSemver(provVersion, req.versionRange)) {
				throw new PluginDependencyError(
					`Plugin ${id} requires service ${req.id} with version range ${req.versionRange}, but provider ${providerId} offers version ${provVersion}`,
				);
			}

			if (providerId !== id) {
				required.add(providerId);
			}
		}

		for (const opt of plugin.manifest.optional ?? []) {
			const providerId = providerByService.get(opt.id);
			if (providerId && providerId !== id) {
				const providerPlugin = byId.get(providerId)!;
				const provEntry = providerPlugin.manifest.provides?.find((p) => p.id === opt.id);
				const provVersion = provEntry?.version ?? providerPlugin.manifest.version;

				if (!opt.versionRange || matchesSemver(provVersion, opt.versionRange)) {
					required.add(providerId);
				}
			}
		}

		dependencies.set(id, required);
	}

	const result: Plugin[] = [];
	const visiting = new Set<string>();
	const visited = new Set<string>();

	function visit(id: string, path: readonly string[]): void {
		if (visited.has(id)) return;
		if (visiting.has(id)) {
			throw new PluginDependencyError(`Plugin dependency cycle: ${[...path, id].join(" -> ")}`);
		}
		visiting.add(id);
		for (const dep of dependencies.get(id) ?? []) {
			visit(dep, [...path, id]);
		}
		visiting.delete(id);
		visited.add(id);
		result.push(byId.get(id)!);
	}

	for (const plugin of plugins) {
		visit(plugin.manifest.id, []);
	}

	return result;
}
