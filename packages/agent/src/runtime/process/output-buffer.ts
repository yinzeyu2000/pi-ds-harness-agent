export interface ProcessOutputChunk {
	readonly seq: number;
	readonly data: string;
	readonly stream: "stdout" | "stderr";
	readonly timestamp: number;
}

export interface OutputBatch {
	readonly chunks: readonly ProcessOutputChunk[];
	readonly watermarkSeq: number;
	readonly truncated: boolean;
	readonly truncatedBytes: number;
	readonly hasMore: boolean;
}

export interface ReadBufferOptions {
	readonly afterSeq?: number;
	readonly maxBytes?: number;
	readonly waitMs?: number;
}

export class BoundedOutputBuffer {
	readonly maxBytes: number;
	private nextSeq = 1;
	private chunks: ProcessOutputChunk[] = [];
	private currentBytes = 0;
	private totalTruncatedBytes = 0;
	private isTruncated = false;
	private isClosed = false;
	private waiters: Array<() => void> = [];

	constructor(maxBytes = 512 * 1024) {
		this.maxBytes = maxBytes;
	}

	get watermarkSeq(): number {
		return this.nextSeq - 1;
	}

	get bufferedBytes(): number {
		return this.currentBytes;
	}

	get truncatedBytes(): number {
		return this.totalTruncatedBytes;
	}

	get truncated(): boolean {
		return this.isTruncated;
	}

	append(data: string | Uint8Array, stream: "stdout" | "stderr" = "stdout"): ProcessOutputChunk {
		const text = typeof data === "string" ? data : new TextDecoder("utf8").decode(data);
		const bytes = new TextEncoder().encode(text).length;

		// Head-drop truncation if single chunk exceeds capacity or buffer overflows
		while (this.chunks.length > 0 && this.currentBytes + bytes > this.maxBytes) {
			const evicted = this.chunks.shift()!;
			const evictedBytes = new TextEncoder().encode(evicted.data).length;
			this.currentBytes -= evictedBytes;
			this.totalTruncatedBytes += evictedBytes;
			this.isTruncated = true;
		}

		const chunk: ProcessOutputChunk = {
			seq: this.nextSeq++,
			data: text,
			stream,
			timestamp: Date.now(),
		};

		this.chunks.push(chunk);
		this.currentBytes += bytes;

		// Notify long-polling readers
		const listeners = [...this.waiters];
		this.waiters.length = 0;
		for (const wake of listeners) {
			wake();
		}

		return chunk;
	}

	async read(options?: ReadBufferOptions): Promise<OutputBatch> {
		const afterSeq = options?.afterSeq ?? 0;
		const maxBytes = options?.maxBytes ?? this.maxBytes;
		const waitMs = options?.waitMs ?? 0;

		const matching = this.getMatchingChunks(afterSeq, maxBytes);

		if (matching.chunks.length > 0 || waitMs <= 0 || this.isClosed) {
			return matching;
		}

		// Long-poll wait for incoming chunk
		await new Promise<void>((resolve) => {
			let timer: any;
			const wake = () => {
				if (timer) clearTimeout(timer);
				resolve();
			};
			if (waitMs > 0) {
				timer = setTimeout(() => {
					const idx = this.waiters.indexOf(wake);
					if (idx !== -1) this.waiters.splice(idx, 1);
					resolve();
				}, waitMs);
			}
			this.waiters.push(wake);
		});

		return this.getMatchingChunks(afterSeq, maxBytes);
	}

	private getMatchingChunks(afterSeq: number, maxBytes: number): OutputBatch {
		const collected: ProcessOutputChunk[] = [];
		let bytesCount = 0;
		let lastSeq = afterSeq;
		let hasMore = false;

		for (const chunk of this.chunks) {
			if (chunk.seq <= afterSeq) {
				continue;
			}
			const chunkBytes = new TextEncoder().encode(chunk.data).length;
			if (bytesCount + chunkBytes > maxBytes && collected.length > 0) {
				hasMore = true;
				break;
			}
			collected.push(chunk);
			bytesCount += chunkBytes;
			lastSeq = chunk.seq;
		}

		return {
			chunks: collected,
			watermarkSeq: lastSeq,
			truncated: this.isTruncated,
			truncatedBytes: this.totalTruncatedBytes,
			hasMore,
		};
	}

	close(): void {
		this.isClosed = true;
		const listeners = [...this.waiters];
		this.waiters.length = 0;
		for (const wake of listeners) {
			wake();
		}
	}
}
