import { asRuntimeGeneration, type RuntimeGeneration, type ThreadId } from "@earendil-works/pi-protocol";
import type {
	HostLifecycleCoordinator,
	LifecycleShutdownSummary,
	ThreadResidencyPin,
	ThreadResidencyRecord,
} from "../types/runtime-host.ts";

interface InternalResidencyRecord {
	threadId: ThreadId;
	generation: RuntimeGeneration;
	residencyState: "not_loaded" | "starting" | "idle" | "active" | "stopping" | "failed";
	durableState: "active" | "archived" | "deleted";
	loadedAt: number;
	pins: Map<string, ThreadResidencyPin>;
}

export class HostLifecycleCoordinatorImpl implements HostLifecycleCoordinator {
	private readonly records = new Map<string, InternalResidencyRecord>();
	private generationCounter = 0;

	async startThread(threadId: ThreadId): Promise<ThreadResidencyRecord> {
		this.generationCounter++;
		const generation = asRuntimeGeneration(this.generationCounter);
		const now = Date.now();

		const record: InternalResidencyRecord = {
			threadId,
			generation,
			residencyState: "idle",
			durableState: "active",
			loadedAt: now,
			pins: new Map(),
		};
		this.records.set(threadId, record);

		return this.toPublicRecord(record);
	}

	async resumeThread(threadId: ThreadId): Promise<ThreadResidencyRecord> {
		const existing = this.records.get(threadId);
		if (existing && existing.residencyState !== "not_loaded") {
			return this.toPublicRecord(existing);
		}
		return this.startThread(threadId);
	}

	async unloadThread(threadId: ThreadId, expectedGeneration: RuntimeGeneration, force = false): Promise<boolean> {
		const existing = this.records.get(threadId);
		if (!existing) return false;

		// Generation fencing
		if (existing.generation !== expectedGeneration) {
			return false;
		}

		// Pin check: cannot unload while pinned unless forced
		if (!force && existing.pins.size > 0) {
			return false;
		}

		existing.residencyState = "not_loaded";
		this.records.delete(threadId);
		return true;
	}

	async archiveThread(threadId: ThreadId): Promise<void> {
		const existing = this.records.get(threadId);
		if (existing) {
			existing.durableState = "archived";
			existing.residencyState = "not_loaded";
			this.records.delete(threadId);
		}
	}

	async deleteThread(threadId: ThreadId): Promise<void> {
		const existing = this.records.get(threadId);
		if (existing) {
			existing.durableState = "deleted";
			existing.residencyState = "not_loaded";
			this.records.delete(threadId);
		}
	}

	async pinThread(threadId: ThreadId, pinId: string, reason: string): Promise<void> {
		const existing = this.records.get(threadId);
		if (!existing) {
			throw new Error(`Cannot pin thread ${threadId}: not loaded`);
		}
		existing.pins.set(pinId, {
			pinId,
			reason,
			acquiredAt: Date.now(),
		});
	}

	async unpinThread(threadId: ThreadId, pinId: string): Promise<void> {
		const existing = this.records.get(threadId);
		if (existing) {
			existing.pins.delete(pinId);
		}
	}

	async shutdownAll(_timeoutMs = 5000): Promise<LifecycleShutdownSummary> {
		const completed: ThreadId[] = [];
		const timedOut: ThreadId[] = [];

		for (const [id, rec] of this.records.entries()) {
			rec.residencyState = "not_loaded";
			completed.push(rec.threadId);
			this.records.delete(id);
		}

		return {
			completed,
			submitFailed: [],
			timedOut,
		};
	}

	getResidency(threadId: ThreadId): ThreadResidencyRecord | undefined {
		const existing = this.records.get(threadId);
		return existing ? this.toPublicRecord(existing) : undefined;
	}

	private toPublicRecord(internal: InternalResidencyRecord): ThreadResidencyRecord {
		return {
			threadId: internal.threadId,
			generation: internal.generation,
			residencyState: internal.residencyState,
			durableState: internal.durableState,
			loadedAt: internal.loadedAt,
			activePins: Array.from(internal.pins.values()),
		};
	}
}
