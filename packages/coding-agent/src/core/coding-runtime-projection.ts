import { projectSession, type SessionProjectionSnapshot } from "@earendil-works/pi-agent-core";
import type { PiAgentRecoveryState } from "@pi-ds/harness-runtime";
import type { CodingRuntime } from "./coding-runtime.ts";

export interface CodingRuntimeSnapshot {
	profileId: string;
	session: { id: string; cwd: string; path: string; name?: string };
	toolNames: readonly string[];
	skillNames: readonly string[];
	model: { provider: string; id: string; name: string };
	thinkingLevel: CodingRuntime["driver"]["thinkingLevel"];
	recovery: PiAgentRecoveryState;
	projection: SessionProjectionSnapshot;
}

export type CodingRuntimeSnapshotListener = (snapshot: CodingRuntimeSnapshot) => void | Promise<void>;

/** Durable read model for UI and protocol consumers. */
export class CodingRuntimeProjection {
	private readonly runtime: CodingRuntime;
	private current: CodingRuntimeSnapshot;
	private readonly listeners = new Set<CodingRuntimeSnapshotListener>();
	private readonly unsubscribers: Array<() => void>;
	private refreshTail = Promise.resolve();
	private disposed = false;

	private constructor(runtime: CodingRuntime, initial: CodingRuntimeSnapshot) {
		this.runtime = runtime;
		this.current = initial;
		const refresh = () => this.enqueueRefresh();
		this.unsubscribers = [
			runtime.driver.events.on("operation/started", refresh),
			runtime.driver.events.on("operation/settled", refresh),
			runtime.driver.events.on("message/committed", refresh),
		];
	}

	static async create(runtime: CodingRuntime): Promise<CodingRuntimeProjection> {
		return new CodingRuntimeProjection(runtime, await readCodingRuntimeSnapshot(runtime));
	}

	get snapshot(): CodingRuntimeSnapshot {
		return structuredClone(this.current);
	}

	subscribe(listener: CodingRuntimeSnapshotListener, emitCurrent = true): () => void {
		if (this.disposed) throw new Error("Coding Runtime Projection is disposed");
		this.listeners.add(listener);
		if (emitCurrent) void this.notify(listener, this.snapshot);
		return () => this.listeners.delete(listener);
	}

	refresh(): Promise<void> {
		if (this.disposed) return Promise.reject(new Error("Coding Runtime Projection is disposed"));
		return this.enqueueRefresh();
	}

	async settle(): Promise<void> {
		await this.refreshTail;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const unsubscribe of this.unsubscribers) unsubscribe();
		this.listeners.clear();
	}

	private enqueueRefresh(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		const refresh = this.refreshTail.then(async () => {
			if (this.disposed) return;
			this.current = await readCodingRuntimeSnapshot(this.runtime);
			const snapshot = this.snapshot;
			await Promise.all([...this.listeners].map((listener) => this.notify(listener, snapshot)));
		});
		this.refreshTail = refresh.catch(() => undefined);
		return refresh;
	}

	private async notify(listener: CodingRuntimeSnapshotListener, snapshot: CodingRuntimeSnapshot): Promise<void> {
		try {
			await listener(structuredClone(snapshot));
		} catch {
			// Observers are isolated from the durable projection refresh chain.
		}
	}
}

export async function readCodingRuntimeSnapshot(runtime: CodingRuntime): Promise<CodingRuntimeSnapshot> {
	const [projection, recovery, name] = await Promise.all([
		projectSession(runtime.session),
		runtime.driver.getRecoveryState(),
		runtime.session.getName(),
	]);
	return {
		profileId: runtime.profile.id,
		session: {
			id: runtime.sessionId,
			cwd: runtime.cwd,
			path: runtime.sessionPath,
			...(name === undefined ? {} : { name }),
		},
		toolNames: [...runtime.toolNames],
		skillNames: runtime.skills.map((skill) => skill.name),
		model: {
			provider: runtime.driver.model.provider,
			id: runtime.driver.model.id,
			name: runtime.driver.model.name,
		},
		thinkingLevel: runtime.driver.thinkingLevel,
		recovery,
		projection,
	};
}
