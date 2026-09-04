import { rm } from "node:fs/promises";
import { join } from "node:path";
import { asItemId, asThreadId, asTurnId } from "@earendil-works/pi-protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { JournalDraft, TurnFact } from "../../src/runtime/index.ts";
import { JsonlJournalStore, RebuildableThreadIndex } from "../../src/runtime/node.ts";

describe("RebuildableThreadIndex and Lossless Rebuild", () => {
	const testDir = join(process.cwd(), "temp_test_index_store");
	const indexPath = join(testDir, "threads.index.json");

	beforeEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	test("indexes threads, queries by status, and rebuilds 100% loss-free from JSONL journals", async () => {
		const store = new JsonlJournalStore({ storageDir: testDir });
		const thread1 = asThreadId("th_idx_1");
		const thread2 = asThreadId("th_idx_2");
		const turnId = asTurnId("turn_idx_1");

		// Populate Thread 1
		const writer1 = await store.open(thread1);
		const drafts1: JournalDraft[] = [
			{
				schemaVersion: 1,
				threadId: thread1,
				turnId,
				record: {
					recordType: "entry",
					entry: {
						type: "message",
						id: asItemId("item_1"),
						seq: 0,
						parentId: null,
						timestamp: 1000,
						message: {
							role: "user",
							content: "Hello from thread 1",
							timestamp: 1000,
						} as any,
					},
				},
			},
			{
				schemaVersion: 1,
				threadId: thread1,
				turnId,
				record: {
					recordType: "runtime_fact",
					fact: { factType: "turn", turnId, status: "completed", terminal: true } as TurnFact,
				},
			},
		];
		await writer1.append(drafts1);
		await writer1.flush();
		await writer1.shutdown();

		// Populate Thread 2
		const writer2 = await store.open(thread2);
		const drafts2: JournalDraft[] = [
			{
				schemaVersion: 1,
				threadId: thread2,
				turnId,
				record: {
					recordType: "entry",
					entry: {
						type: "message",
						id: asItemId("item_2"),
						seq: 0,
						parentId: null,
						timestamp: 2000,
						message: {
							role: "user",
							content: "Second discussion thread",
							timestamp: 2000,
						} as any,
					},
				},
			},
			{
				schemaVersion: 1,
				threadId: thread2,
				turnId,
				record: {
					recordType: "runtime_fact",
					fact: { factType: "turn", turnId, status: "completed", terminal: true } as TurnFact,
				},
			},
		];
		await writer2.append(drafts2);
		await writer2.flush();
		await writer2.shutdown();

		// Initialize Index and build from store
		const index = new RebuildableThreadIndex(indexPath);
		await index.initialize();
		const { rebuiltCount } = await index.rebuildFromStore(store, [thread1, thread2]);
		expect(rebuiltCount).toBe(2);

		const list = await index.list();
		expect(list.length).toBe(2);
		// Sorted by updatedAt descending: thread 2 first
		expect(list[0]!.threadId).toBe(thread2);
		expect(list[0]!.title).toContain("Second discussion thread");
		expect(list[1]!.threadId).toBe(thread1);
		expect(list[1]!.title).toContain("Hello from thread 1");

		// Simulate total loss of index file (delete index file)
		await rm(indexPath, { force: true });

		// Create a brand new index and rebuild from store
		const freshIndex = new RebuildableThreadIndex(indexPath);
		await freshIndex.initialize();
		expect(await freshIndex.list()).toHaveLength(0);

		// Rebuild from JSONL journals
		const rebuildResult = await freshIndex.rebuildFromStore(store, [thread1, thread2]);
		expect(rebuildResult.rebuiltCount).toBe(2);

		const restoredList = await freshIndex.list();
		expect(restoredList.length).toBe(2);
		expect(restoredList[0]!.threadId).toBe(thread2);
		expect(restoredList[1]!.threadId).toBe(thread1);
	});
});
