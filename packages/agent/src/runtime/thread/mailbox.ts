import { type ControllerLease, computePayloadHash, formatDeduplicationKey } from "@earendil-works/pi-protocol";
import { CommandDeduplicationConflictError, ControllerFencingError } from "../types/errors.ts";
import type { LoadedThreadMailbox, MailboxMessage } from "../types/thread-runtime.ts";

interface DeduplicationRecord {
	readonly payloadHash: string;
	status: "in_flight" | "completed" | "failed";
	result?: unknown;
	error?: Error;
	promise?: Promise<unknown>;
}

export type MailboxHandler = (message: MailboxMessage<any>) => Promise<unknown>;

export class LoadedThreadMailboxImpl implements LoadedThreadMailbox {
	private readonly dedupeRecords = new Map<string, DeduplicationRecord>();
	private readonly queue: Array<{
		message: MailboxMessage<any>;
		handler: MailboxHandler;
		resolve: (value: any) => void;
		reject: (reason: any) => void;
	}> = [];
	private processing = false;
	private activeLeaseSupplier: () => ControllerLease | undefined;

	constructor(activeLeaseSupplier: () => ControllerLease | undefined = () => undefined) {
		this.activeLeaseSupplier = activeLeaseSupplier;
	}

	get pendingCount(): number {
		return this.queue.length;
	}

	async submit<TInput, TOutput>(message: MailboxMessage<TInput>, handler?: MailboxHandler): Promise<TOutput> {
		const keyStr = formatDeduplicationKey(message.dedupeKey);
		const hash = computePayloadHash(message.payload);

		// Check deduplication
		const existing = this.dedupeRecords.get(keyStr);
		if (existing) {
			if (existing.payloadHash !== hash) {
				throw new CommandDeduplicationConflictError(
					`Conflicting payload hash for clientRequestId ${message.clientRequestId}`,
					{ key: keyStr, existingHash: existing.payloadHash, newHash: hash },
				);
			}
			if (existing.status === "completed") {
				return existing.result as TOutput;
			}
			if (existing.status === "failed") {
				throw existing.error ?? new Error("Previous command execution failed");
			}
			if (existing.promise) {
				return (await existing.promise) as TOutput;
			}
		}

		// Controller Epoch check
		if (message.controllerEpoch !== undefined) {
			const activeLease = this.activeLeaseSupplier();
			if (!activeLease || activeLease.epoch !== message.controllerEpoch) {
				throw new ControllerFencingError(
					`Command rejected: required controller epoch ${message.controllerEpoch} does not match active epoch ${activeLease?.epoch ?? "none"}`,
					{ required: message.controllerEpoch, active: activeLease?.epoch },
				);
			}
		}

		let recordResolve!: (val: unknown) => void;
		let recordReject!: (err: unknown) => void;
		const executionPromise = new Promise<unknown>((res, rej) => {
			recordResolve = res;
			recordReject = rej;
		});

		const record: DeduplicationRecord = {
			payloadHash: hash,
			status: "in_flight",
			promise: executionPromise,
		};
		this.dedupeRecords.set(keyStr, record);

		const actualHandler = handler ?? (async (msg) => msg.payload);

		return new Promise<TOutput>((resolve, reject) => {
			this.queue.push({
				message,
				handler: actualHandler,
				resolve: (val) => {
					record.status = "completed";
					record.result = val;
					recordResolve(val);
					resolve(val);
				},
				reject: (err) => {
					record.status = "failed";
					record.error = err instanceof Error ? err : new Error(String(err));
					recordReject(err);
					reject(err);
				},
			});
			void this.processNext();
		});
	}

	private async processNext(): Promise<void> {
		if (this.processing) return;
		if (this.queue.length === 0) return;

		this.processing = true;
		const item = this.queue.shift()!;

		try {
			const result = await item.handler(item.message);
			item.resolve(result);
		} catch (error) {
			item.reject(error);
		} finally {
			this.processing = false;
			void this.processNext();
		}
	}

	async drain(): Promise<void> {
		while (this.queue.length > 0 || this.processing) {
			await new Promise((r) => setTimeout(r, 10));
		}
	}
}
