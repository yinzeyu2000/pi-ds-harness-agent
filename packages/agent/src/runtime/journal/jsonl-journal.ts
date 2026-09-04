import { closeSync, existsSync, openSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type AcceptedReceipt,
	asEventId,
	type PersistedReceipt,
	type PowerLossDurableReceipt,
	type ThreadId,
} from "@earendil-works/pi-protocol";
import { RuntimeInvariantError } from "../types/errors.ts";
import type {
	CheckpointRef,
	JournalDraft,
	JournalEnvelope,
	JournalRecord,
	JournalWriter,
	ThreadJournalStore,
} from "../types/journal.ts";

export interface JsonlStoreOptions {
	readonly storageDir: string;
}

export class JsonlJournalWriter implements JournalWriter {
	readonly threadId: ThreadId;
	readonly journalPath: string;
	readonly lockPath: string;
	readonly checkpointDir: string;

	private nextSeq = 1;
	private persistedSeq = 0;
	private durableSeq = 0;
	private fileHandle?: FileHandle;
	private unpersistedEnvelopes: JournalEnvelope[] = [];
	private committedEnvelopesMemory: JournalEnvelope[] = [];
	private isClosed = false;

	constructor(threadId: ThreadId, storageDir: string, initialSeq = 1) {
		this.threadId = threadId;
		const threadDir = join(storageDir, "threads", threadId);
		this.journalPath = join(threadDir, "journal.jsonl");
		this.lockPath = join(threadDir, "journal.lock");
		this.checkpointDir = join(threadDir, "checkpoints");
		this.nextSeq = initialSeq;
		this.persistedSeq = initialSeq - 1;
		this.durableSeq = initialSeq - 1;
	}

	get committedEnvelopes(): readonly JournalEnvelope[] {
		return [...this.committedEnvelopesMemory];
	}

	async initialize(): Promise<void> {
		const threadDir = dirname(this.journalPath);
		await mkdir(threadDir, { recursive: true });
		await mkdir(this.checkpointDir, { recursive: true });

		// Acquire exclusive file lock
		try {
			const lockFd = openSync(this.lockPath, "wx");
			const lockInfo = JSON.stringify({
				pid: process.pid,
				threadId: this.threadId,
				lockedAt: Date.now(),
			});
			writeFileSync(lockFd, lockInfo, "utf8");
			closeSync(lockFd);
		} catch (err: any) {
			if (err && err.code === "EEXIST") {
				throw new Error(
					`ThreadJournalStore locked: thread ${this.threadId} is currently locked by another writer at ${this.lockPath}`,
				);
			}
			throw err;
		}

		// Open or create journal file
		this.fileHandle = await open(this.journalPath, "a+");
	}

	async append(drafts: readonly JournalDraft[]): Promise<AcceptedReceipt> {
		if (this.isClosed) {
			throw new Error(`Cannot append to closed JSONL journal writer for thread ${this.threadId}`);
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

			this.unpersistedEnvelopes.push(envelope);
			this.committedEnvelopesMemory.push(envelope);
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
		if (this.isClosed) {
			throw new Error("Cannot persist to closed writer");
		}
		if (!this.fileHandle) {
			throw new Error("Writer not initialized");
		}

		if (this.unpersistedEnvelopes.length > 0) {
			const toPersist: JournalEnvelope[] = [];
			const remaining: JournalEnvelope[] = [];
			const target = upToSeq ?? this.nextSeq - 1;

			for (const env of this.unpersistedEnvelopes) {
				if (env.seq <= target) {
					toPersist.push(env);
				} else {
					remaining.push(env);
				}
			}

			if (toPersist.length > 0) {
				const lines = `${toPersist.map((e) => JSON.stringify(e)).join("\n")}\n`;
				await this.fileHandle.write(lines);
				this.persistedSeq = toPersist[toPersist.length - 1]!.seq;
				this.unpersistedEnvelopes = remaining;
			}
		}

		return {
			level: "persisted",
			threadId: this.threadId,
			watermarkSeq: this.persistedSeq,
			persistedAt: Date.now(),
		};
	}

	async flush(upToSeq?: number): Promise<PowerLossDurableReceipt> {
		if (this.isClosed) {
			throw new Error("Cannot flush closed writer");
		}
		if (!this.fileHandle) {
			throw new Error("Writer not initialized");
		}

		const persisted = await this.persist(upToSeq);

		// Physical fsync barrier
		await this.fileHandle.sync();
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
		const filename = `${String(watermark).padStart(12, "0")}.json`;
		const path = join(this.checkpointDir, filename);

		const metadata: CheckpointRef = {
			checkpointSeq: watermark,
			snapshotHash: `chkpt_${this.threadId}_${watermark}`,
			timestamp: Date.now(),
		};

		const content = JSON.stringify(metadata, null, 2);
		await appendFile(path, content, "utf8");

		return metadata;
	}

	async shutdown(): Promise<void> {
		if (this.isClosed) return;
		try {
			await this.flush();
		} finally {
			this.isClosed = true;
			if (this.fileHandle) {
				await this.fileHandle.close();
				this.fileHandle = undefined;
			}
			if (existsSync(this.lockPath)) {
				try {
					unlinkSync(this.lockPath);
				} catch {
					// Ignore lock removal failure on exit
				}
			}
		}
	}

	async discard(): Promise<void> {
		this.isClosed = true;
		if (this.fileHandle) {
			await this.fileHandle.close();
			this.fileHandle = undefined;
		}
		if (existsSync(this.lockPath)) {
			try {
				unlinkSync(this.lockPath);
			} catch {
				// Ignore lock removal failure
			}
		}
	}
}

export class JsonlJournalStore implements ThreadJournalStore {
	readonly storageDir: string;

	constructor(options: JsonlStoreOptions) {
		this.storageDir = options.storageDir;
	}

	async open(threadId: ThreadId): Promise<JsonlJournalWriter> {
		// Read existing envelopes to calculate next sequence and recover torn tail if needed
		let lastSeq = 0;
		for await (const env of this.load(threadId)) {
			if (env.seq > lastSeq) {
				lastSeq = env.seq;
			}
		}

		const writer = new JsonlJournalWriter(threadId, this.storageDir, lastSeq + 1);
		await writer.initialize();
		return writer;
	}

	async *load(threadId: ThreadId, afterSeq = 0): AsyncIterable<JournalEnvelope> {
		const threadDir = join(this.storageDir, "threads", threadId);
		const journalPath = join(threadDir, "journal.jsonl");

		if (!existsSync(journalPath)) {
			return;
		}

		const content = await readFile(journalPath, "utf8");
		if (content.trim().length === 0) {
			return;
		}

		// Split on newline
		const lines = content.split("\n");
		let validBytesOffset = 0;
		let lastValidSeq = 0;
		let hasTornTail = false;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			const isLastLine = i === lines.length - 1;

			if (line.trim().length === 0) {
				validBytesOffset += Buffer.byteLength(line, "utf8") + 1;
				continue;
			}

			let envelope: JournalEnvelope;
			try {
				envelope = JSON.parse(line) as JournalEnvelope;
			} catch (parseErr) {
				if (isLastLine) {
					// Torn tail at the end of the log
					hasTornTail = true;
					break;
				}
				// Mid-log corruption!
				throw new RuntimeInvariantError(
					`Mid-log corruption detected in thread ${threadId} at line ${i + 1}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
					{ threadId, lineIndex: i + 1 },
				);
			}

			// Validate monotonic sequence order
			if (envelope.seq <= lastValidSeq) {
				throw new RuntimeInvariantError(
					`Mid-log sequence discontinuity in thread ${threadId} at line ${i + 1}: seq ${envelope.seq} <= lastSeq ${lastValidSeq}`,
					{ threadId, lineIndex: i + 1, seq: envelope.seq, lastValidSeq },
				);
			}

			lastValidSeq = envelope.seq;
			validBytesOffset += Buffer.byteLength(line, "utf8") + 1;

			if (envelope.seq > afterSeq) {
				yield envelope;
			}
		}

		// If torn tail was detected at the very end, truncate file to last complete record
		if (hasTornTail) {
			try {
				truncateSync(journalPath, validBytesOffset);
			} catch {
				// Truncation best effort
			}
		}
	}
}
