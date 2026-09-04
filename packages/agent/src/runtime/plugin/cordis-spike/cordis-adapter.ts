import type { Effect, EventToken, ManagedTask, Plugin, PluginContext } from "../context.ts";
import { PluginActivationError, PluginDependencyError } from "../plugin-host.ts";
import type { ServiceToken } from "../tokens.ts";

/**
 * Cordis-style Context Spike Implementation.
 * Models Cordis prototype-chain scope inheritance, service properties on context,
 * and lifecycle hooks behind our project-owned Plugin interface.
 */
export class CordisSpikeContext {
	readonly pluginId: string;
	readonly signal: AbortSignal;
	private readonly abortController = new AbortController();
	private readonly registry: Map<string, unknown>;
	private readonly disposers: Array<() => void | Promise<void>> = [];

	constructor(pluginId = "root", sharedRegistry: Map<string, unknown> = new Map()) {
		this.pluginId = pluginId;
		this.signal = this.abortController.signal;
		// Cordis uses shared or prototype-delegated service resolution
		this.registry = sharedRegistry;
	}

	defer(disposer: () => void | Promise<void>): void {
		this.disposers.push(disposer);
	}

	use<T>(resource: T, disposer: (resource: T) => void | Promise<void>): T {
		this.defer(() => disposer(resource));
		return resource;
	}

	listen<T>(_event: EventToken<T>, _listener: (event: T) => void): Effect {
		return {
			dispose: () => {},
		};
	}

	task<T>(run: (signal: AbortSignal) => Promise<T>): ManagedTask<T> {
		const taskController = new AbortController();
		const combined = AbortSignal.any([this.signal, taskController.signal]);
		const promise = run(combined);
		return {
			promise,
			abort: () => taskController.abort(),
		};
	}

	provide<T>(token: ServiceToken<T>, value: T): Effect {
		if (this.registry.has(token.id)) {
			throw new Error(`Cordis service conflict: ${token.id} already registered`);
		}
		this.registry.set(token.id, value);
		const disposer = () => {
			if (this.registry.get(token.id) === value) {
				this.registry.delete(token.id);
			}
		};
		this.defer(disposer);
		return { dispose: disposer };
	}

	require<T>(token: ServiceToken<T>): T {
		const val = this.registry.get(token.id);
		if (val === undefined) {
			throw new Error(`Cordis service not found: ${token.id}`);
		}
		return val as T;
	}

	get<T>(token: ServiceToken<T>): T | undefined {
		return this.registry.get(token.id) as T | undefined;
	}

	createChild(pluginId: string): CordisSpikeContext {
		return new CordisSpikeContext(pluginId, this.registry);
	}

	async dispose(): Promise<void> {
		this.abortController.abort();
		const errors: unknown[] = [];
		for (let i = this.disposers.length - 1; i >= 0; i--) {
			try {
				await this.disposers[i]!();
			} catch (err) {
				errors.push(err);
			}
		}
		this.disposers.length = 0;
		if (errors.length > 0) {
			throw new AggregateError(errors, "Cordis spike dispose failed");
		}
	}
}

export class CordisSpikeHost {
	private readonly rootContext = new CordisSpikeContext("cordis-root");
	private readonly children: CordisSpikeContext[] = [];
	private started = false;

	get isStarted(): boolean {
		return this.started;
	}

	async start(plugins: readonly Plugin[]): Promise<void> {
		if (this.started) throw new Error("Cordis host already started");
		this.started = true;

		// Validate services
		const provided = new Set<string>();
		for (const p of plugins) {
			for (const prov of p.manifest.provides ?? []) {
				if (provided.has(prov.id)) {
					throw new PluginDependencyError(`Cordis conflict: duplicate service ${prov.id}`);
				}
				provided.add(prov.id);
			}
		}

		for (const p of plugins) {
			for (const req of p.manifest.requires ?? []) {
				if (!provided.has(req.id)) {
					throw new PluginDependencyError(`Cordis missing dependency: ${req.id} required by ${p.manifest.id}`);
				}
			}
		}

		for (const plugin of plugins) {
			const child = this.rootContext.createChild(plugin.manifest.id);
			try {
				await plugin.activate(child as unknown as PluginContext);
				this.children.push(child);
			} catch (err) {
				await child.dispose();
				await this.stop();
				throw new PluginActivationError(plugin.manifest.id, err);
			}
		}
	}

	async stop(): Promise<void> {
		const errors: unknown[] = [];
		for (let i = this.children.length - 1; i >= 0; i--) {
			try {
				await this.children[i]!.dispose();
			} catch (err) {
				errors.push(err);
			}
		}
		this.children.length = 0;
		await this.rootContext.dispose();
		this.started = false;
		if (errors.length > 0) {
			throw new AggregateError(errors, "Cordis host stop failed");
		}
	}

	get<T>(token: ServiceToken<T>): T | undefined {
		return this.rootContext.get(token);
	}
}
