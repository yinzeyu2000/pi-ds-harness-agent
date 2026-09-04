import {
	type AcceptedReceipt,
	asEventId,
	type PersistedReceipt,
	type PowerLossDurableReceipt,
	type ThreadId,
} from "@earendil-works/pi-protocol";
import type {
	CheckpointRef,
	JournalDraft,
	JournalEnvelope,
	JournalRecord,
	JournalWriter,
	ThreadJournalStore,
} from "../types/journal.ts";

export class MemoryJournalWriter implements JournalWriter {
	readonly threadId: ThreadId;
	private readonly envelopes: JournalEnvelope[] = [];
	private nextSeq = 1;
	private persistedSeq = 0;
	private durableSeq = 0;
	private isClosed = false;

	constructor(threadId: ThreadId) {
		this.threadId = threadId;
	}

	get committedEnvelopes(): readonly JournalEnvelope[] {
		return [...this.envelopes];
	}

	get currentSeq(): number {
		return this.nextSeq - 1;
	}

	async append(drafts: readonly JournalDraft[]): Promise<AcceptedReceipt> {
		if (this.isClosed) {
			throw new Error(`Cannot append to closed journal writer for thread ${this.threadId}`);
		}
		if (drafts.length === 0) {
			throw new Error("Cannot append empty drafts batch");
		}

		let lastEventId = "";
		let lastSeq = this.nextSeq;
		const now = Date.now();

		for (const draft of drafts) {
			const seq = this.nextSeq++;
			const eventId = asEventId(`evt_${this.threadId}_${seq}`);
			lastEventId = eventId;
			lastSeq = seq;

			const envelope: JournalEnvelope = {
				schemaVersion: draft.schemaVersion ?? 1,
				eventId,
				seq,
				threadId: this.threadId,
				lane: draft.lane,
				operationId: draft.operationId,
				turnId: draft.turnId,
				stepId: draft.stepId,
				commandId: draft.commandId,
				causationId: draft.causationId,
				correlationId: draft.correlationId,
				timestamp: now,
				record: draft.record as JournalRecord,
				checksum: `chk_${seq}_${now}`,
			};

			this.envelopes.push(envelope);
		}

		return {
			level: "accepted",
			threadId: this.threadId,
			eventId: asEventId(lastEventId),
			seq: lastSeq,
			timestamp: now,
		};
	}

	async persist(upToSeq?: number): Promise<PersistedReceipt> {
		const target = upToSeq ?? this.nextSeq - 1;
		this.persistedSeq = Math.max(this.persistedSeq, Math.min(target, this.nextSeq - 1));
		return {
			level: "persisted",
			threadId: this.threadId,
			watermarkSeq: this.persistedSeq,
			persistedAt: Date.now(),
		};
	}

	async flush(upToSeq?: number): Promise<PowerLossDurableReceipt> {
		const persisted = await this.persist(upToSeq);
		this.durableSeq = Math.max(this.durableSeq, persisted.watermarkSeq);
		return {
			level: "power_loss_durable",
			threadId: this.threadId,
			durableSeq: this.durableSeq,
			syncedAt: Date.now(),
		};
	}

	async checkpoint(): Promise<CheckpointRef> {
		const watermark = this.persistedSeq;
		return {
			checkpointSeq: watermark,
			snapshotHash: `chkpt_${this.threadId}_${watermark}`,
			timestamp: Date.now(),
		};
	}

	async shutdown(): Promise<void> {
		await this.flush();
		this.isClosed = true;
	}

	async discard(): Promise<void> {
		this.isClosed = true;
	}
}

export class MemoryJournalStore implements ThreadJournalStore {
	private readonly writers = new Map<string, MemoryJournalWriter>();

	async open(threadId: ThreadId): Promise<JournalWriter> {
		let writer = this.writers.get(threadId);
		if (!writer) {
			writer = new MemoryJournalWriter(threadId);
			this.writers.set(threadId, writer);
		}
		return writer;
	}

	async *load(threadId: ThreadId, afterSeq = 0): AsyncIterable<JournalEnvelope> {
		const writer = this.writers.get(threadId);
		if (!writer) return;

		for (const env of writer.committedEnvelopes) {
			if (env.seq > afterSeq) {
				yield env;
			}
		}
	}

	get(threadId: ThreadId): MemoryJournalWriter | undefined {
		return this.writers.get(threadId);
	}
}
