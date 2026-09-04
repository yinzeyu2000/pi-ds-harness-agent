import { rm } from "node:fs/promises";
import { join } from "node:path";
import { asThreadId, asTurnId } from "@earendil-works/pi-protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type JournalDraft, MemoryJournalStore, type TurnFact } from "../../src/runtime/index.ts";
import { JsonlJournalStore } from "../../src/runtime/node.ts";

describe("JsonlJournalStore and Durability Tiers", () => {
	const testDir = join(process.cwd(), "temp_test_jsonl_store");
	const threadId = asThreadId("th_jsonl_test");
	const turnId = asTurnId("turn_j1");

	beforeEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	test("writes to disk and supports 3 durability receipt tiers", async () => {
		const store = new JsonlJournalStore({ storageDir: testDir });
		const writer = await store.open(threadId);

		const draft1: JournalDraft = {
			schemaVersion: 1,
			threadId,
			turnId,
			record: {
				recordType: "runtime_fact",
				fact: { factType: "turn", turnId, status: "admitted" } as TurnFact,
			},
		};

		const draft2: JournalDraft = {
			schemaVersion: 1,
			threadId,
			turnId,
			record: {
				recordType: "runtime_fact",
				fact: { factType: "turn", turnId, status: "started" } as TurnFact,
			},
		};

		// 1. Accepted receipt
		const accepted = await writer.append([draft1, draft2]);
		expect(accepted.level).toBe("accepted");
		expect(accepted.seq).toBe(2);

		// 2. Persisted receipt
		const persisted = await writer.persist();
		expect(persisted.level).toBe("persisted");
		expect(persisted.watermarkSeq).toBe(2);

		// 3. Power-loss durable receipt (physical fsync)
		const durable = await writer.flush();
		expect(durable.level).toBe("power_loss_durable");
		expect(durable.durableSeq).toBe(2);

		// Checkpoint
		const checkpoint = await writer.checkpoint();
		expect(checkpoint.checkpointSeq).toBe(2);

		await writer.shutdown();

		// Reload from disk
		const loaded: any[] = [];
		for await (const env of store.load(threadId)) {
			loaded.push(env);
		}

		expect(loaded.length).toBe(2);
		expect(loaded[0].seq).toBe(1);
		expect(loaded[1].seq).toBe(2);
	});

	test("conformance parity between MemoryStore and JsonlStore", async () => {
		const memStore = new MemoryJournalStore();
		const jsonlStore = new JsonlJournalStore({ storageDir: testDir });

		const memWriter = await memStore.open(threadId);
		const jsonlWriter = await jsonlStore.open(threadId);

		const drafts: JournalDraft[] = [
			{
				schemaVersion: 1,
				threadId,
				turnId,
				record: {
					recordType: "runtime_fact",
					fact: { factType: "turn", turnId, status: "admitted" } as TurnFact,
				},
			},
		];

		const memReceipt = await memWriter.append(drafts);
		const jsonlReceipt = await jsonlWriter.append(drafts);

		expect(memReceipt.seq).toBe(jsonlReceipt.seq);
		expect(memReceipt.level).toBe(jsonlReceipt.level);

		await memWriter.flush();
		await jsonlWriter.flush();

		const memLoaded: any[] = [];
		for await (const env of memStore.load(threadId)) memLoaded.push(env);

		const jsonlLoaded: any[] = [];
		for await (const env of jsonlStore.load(threadId)) jsonlLoaded.push(env);

		expect(memLoaded.length).toBe(jsonlLoaded.length);
		expect(memLoaded[0].seq).toBe(jsonlLoaded[0].seq);
		expect(memLoaded[0].record).toEqual(jsonlLoaded[0].record);

		await memWriter.shutdown();
		await jsonlWriter.shutdown();
	});

	test("file locking prevents concurrent writers on the same thread", async () => {
		const store = new JsonlJournalStore({ storageDir: testDir });
		const writer1 = await store.open(threadId);

		// Attempting to open second writer while first writer holds the lock
		await expect(store.open(threadId)).rejects.toThrow("locked");

		// Shutdown writer 1
		await writer1.shutdown();

		// Now opening writer 2 succeeds
		const writer2 = await store.open(threadId);
		expect(writer2).toBeDefined();
		await writer2.shutdown();
	});
});
