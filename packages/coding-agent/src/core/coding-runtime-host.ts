import type { AgentEvent, JsonlSessionMetadata } from "@earendil-works/pi-agent-core";
import type { CodingRuntime } from "./coding-runtime.ts";
import { CodingRuntimeController } from "./coding-runtime-controller.ts";
import type { CodingRuntimeSnapshot, CodingRuntimeSnapshotListener } from "./coding-runtime-projection.ts";

export interface CodingRuntimeTarget {
	sessionId?: string;
	cwd: string;
	parentSessionId?: string;
}

export type CodingRuntimeFactory = (target: CodingRuntimeTarget) => Promise<CodingRuntime>;

export interface CodingRuntimeReplacement {
	previousSessionId: string;
	sessionId: string;
	snapshot: CodingRuntimeSnapshot;
}

/** Owns one replaceable Coding Runtime and keeps consumers bound to its durable Projection. */
export class CodingRuntimeHost {
	private runtime: CodingRuntime;
	private currentController: CodingRuntimeController;
	private readonly factory: CodingRuntimeFactory;
	private readonly snapshotListeners = new Set<CodingRuntimeSnapshotListener>();
	private readonly replacementListeners = new Set<(replacement: CodingRuntimeReplacement) => void | Promise<void>>();
	private readonly agentEventListeners = new Set<(event: AgentEvent) => void | Promise<void>>();
	private unsubscribeProjection: () => void;
	private unsubscribeAgentEvents: () => void;
	private replacing = false;
	private disposed = false;

	private constructor(runtime: CodingRuntime, controller: CodingRuntimeController, factory: CodingRuntimeFactory) {
		this.runtime = runtime;
		this.currentController = controller;
		this.factory = factory;
		this.unsubscribeProjection = controller.subscribe((snapshot) => this.publishSnapshot(snapshot), false);
		this.unsubscribeAgentEvents = controller.onAgentEvent((event) => this.publishAgentEvent(event));
	}

	static async create(runtime: CodingRuntime, factory: CodingRuntimeFactory): Promise<CodingRuntimeHost> {
		return new CodingRuntimeHost(runtime, await CodingRuntimeController.create(runtime), factory);
	}

	get controller(): CodingRuntimeController {
		this.assertActive();
		return this.currentController;
	}

	get snapshot(): CodingRuntimeSnapshot {
		return this.controller.snapshot;
	}

	subscribe(listener: CodingRuntimeSnapshotListener, emitCurrent = true): () => void {
		this.assertActive();
		this.snapshotListeners.add(listener);
		if (emitCurrent) void this.notify(listener, this.snapshot);
		return () => this.snapshotListeners.delete(listener);
	}

	onReplaced(listener: (replacement: CodingRuntimeReplacement) => void | Promise<void>): () => void {
		this.assertActive();
		this.replacementListeners.add(listener);
		return () => this.replacementListeners.delete(listener);
	}

	onAgentEvent(listener: (event: AgentEvent) => void | Promise<void>): () => void {
		this.assertActive();
		this.agentEventListeners.add(listener);
		return () => this.agentEventListeners.delete(listener);
	}

	async switchSession(target: CodingRuntimeTarget & { sessionId: string }): Promise<CodingRuntimeReplacement> {
		return this.replaceRuntime(target, false);
	}

	async newSession(options?: {
		id?: string;
		cwd?: string;
		parentSessionId?: string;
	}): Promise<CodingRuntimeReplacement> {
		this.assertActive();
		return this.replaceRuntime(
			{
				cwd: options?.cwd ?? this.runtime.cwd,
				...(options?.id === undefined ? {} : { sessionId: options.id }),
				...(options?.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
			},
			true,
		);
	}

	reload(): Promise<CodingRuntimeReplacement> {
		this.assertActive();
		return this.replaceRuntime({ sessionId: this.runtime.sessionId, cwd: this.runtime.cwd }, true);
	}

	private async replaceRuntime(target: CodingRuntimeTarget, force: boolean): Promise<CodingRuntimeReplacement> {
		this.assertActive();
		if (this.replacing) throw new Error("Coding Runtime replacement is already in progress");
		if (!force && target.sessionId === this.runtime.sessionId && target.cwd === this.runtime.cwd) {
			return { previousSessionId: target.sessionId, sessionId: target.sessionId, snapshot: this.snapshot };
		}
		this.replacing = true;
		let nextRuntime: CodingRuntime | undefined;
		let nextController: CodingRuntimeController | undefined;
		try {
			await this.assertReplaceable();
			nextRuntime = await this.factory(target);
			nextController = await CodingRuntimeController.create(nextRuntime);
			await this.assertReplaceable();
			const previousSessionId = this.runtime.sessionId;
			this.unsubscribeProjection();
			this.unsubscribeAgentEvents();
			await this.currentController.dispose();
			this.runtime = nextRuntime;
			this.currentController = nextController;
			this.unsubscribeProjection = nextController.subscribe((snapshot) => this.publishSnapshot(snapshot), false);
			this.unsubscribeAgentEvents = nextController.onAgentEvent((event) => this.publishAgentEvent(event));
			const replacement = { previousSessionId, sessionId: nextRuntime.sessionId, snapshot: nextController.snapshot };
			await this.publishSnapshot(replacement.snapshot);
			await Promise.all([...this.replacementListeners].map((listener) => this.notify(listener, replacement)));
			return replacement;
		} catch (error) {
			if (nextController && nextController !== this.currentController) await nextController.dispose();
			else if (nextRuntime && nextRuntime !== this.runtime) await nextRuntime.dispose();
			throw error;
		} finally {
			this.replacing = false;
		}
	}

	async forkAndSwitch(
		options?: Parameters<CodingRuntimeController["forkSession"]>[0],
	): Promise<{ metadata: JsonlSessionMetadata; replacement: CodingRuntimeReplacement }> {
		this.assertActive();
		const metadata = await this.controller.forkSession(options);
		return {
			metadata,
			replacement: await this.switchSession({ sessionId: metadata.id, cwd: metadata.cwd }),
		};
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribeProjection();
		this.unsubscribeAgentEvents();
		this.snapshotListeners.clear();
		this.replacementListeners.clear();
		this.agentEventListeners.clear();
		await this.currentController.dispose();
	}

	private async assertReplaceable(): Promise<void> {
		this.assertActive();
		if (this.currentController.isIdle && (await this.currentController.getRecoveryState()).status === "idle") return;
		throw new Error("Cannot replace the Coding Runtime while it is active or requires recovery");
	}

	private async publishSnapshot(snapshot: CodingRuntimeSnapshot): Promise<void> {
		await Promise.all([...this.snapshotListeners].map((listener) => this.notify(listener, snapshot)));
	}

	private async publishAgentEvent(event: AgentEvent): Promise<void> {
		await Promise.all([...this.agentEventListeners].map((listener) => this.notify(listener, event)));
	}

	private async notify<T>(listener: (value: T) => void | Promise<void>, value: T): Promise<void> {
		try {
			await listener(structuredClone(value));
		} catch {
			// Consumers do not own Runtime replacement or Projection progress.
		}
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("Coding Runtime Host is disposed");
	}
}
