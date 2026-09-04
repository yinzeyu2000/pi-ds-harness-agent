import { describe, expect, test } from "vitest";
import { BoundedOutputBuffer } from "../../src/runtime/index.ts";

describe("BoundedOutputBuffer, Monotonic Sequences, and Flood Truncation", () => {
	test("assigns monotonic sequence numbers to output chunks", () => {
		const buffer = new BoundedOutputBuffer(1024);

		const chunk1 = buffer.append("first\n", "stdout");
		const chunk2 = buffer.append("second\n", "stdout");
		const chunk3 = buffer.append("error\n", "stderr");

		expect(chunk1.seq).toBe(1);
		expect(chunk2.seq).toBe(2);
		expect(chunk3.seq).toBe(3);
		expect(buffer.watermarkSeq).toBe(3);
		expect(buffer.truncated).toBe(false);
	});

	test("output flooding triggers head-drop truncation without exceeding byte ceiling", async () => {
		// Set small buffer limit of 50 bytes
		const buffer = new BoundedOutputBuffer(50);

		// Flood with multiple 20-byte chunks
		for (let i = 0; i < 10; i++) {
			buffer.append(`data_chunk_index_${i.toString().padStart(3, "0")}\n`);
		}

		// Verify buffered bytes never exceeds limit
		expect(buffer.bufferedBytes).toBeLessThanOrEqual(50);
		expect(buffer.truncated).toBe(true);
		expect(buffer.truncatedBytes).toBeGreaterThan(0);

		// Verify remaining chunks are the newest ones
		const batch = await buffer.read();
		expect(batch.chunks.length).toBeGreaterThan(0);
		const lastChunk = batch.chunks[batch.chunks.length - 1]!;
		expect(lastChunk.data).toContain("data_chunk_index_009");
	});

	test("supports incremental cursor read with afterSeq and maxBytes", async () => {
		const buffer = new BoundedOutputBuffer(1024);

		buffer.append("line 1\n");
		buffer.append("line 2\n");
		buffer.append("line 3\n");

		// Read first batch
		const batch1 = await buffer.read({ afterSeq: 0, maxBytes: 15 });
		expect(batch1.chunks.length).toBeGreaterThan(0);
		const cursor = batch1.watermarkSeq;

		// Read second batch starting from cursor
		const batch2 = await buffer.read({ afterSeq: cursor });
		expect(batch2.chunks.length).toBeGreaterThan(0);
		expect(batch2.chunks[0]!.seq).toBeGreaterThan(cursor);
	});

	test("long-poll read resolves immediately when new chunk arrives", async () => {
		const buffer = new BoundedOutputBuffer(1024);

		const readPromise = buffer.read({ afterSeq: 0, waitMs: 1000 });

		// Append chunk after short delay
		setTimeout(() => {
			buffer.append("delayed incoming log\n");
		}, 20);

		const batch = await readPromise;
		expect(batch.chunks.length).toBe(1);
		expect(batch.chunks[0]!.data).toBe("delayed incoming log\n");
	});
});
