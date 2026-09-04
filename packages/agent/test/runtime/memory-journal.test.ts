import { asThreadId, asTurnId } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import {
	type JournalDraft,
	MemoryJournalStore,
	MemoryJournalWriter,
	projectThreadSnapshot,
	type TurnFact,
} from "../../src/runtime/index.ts";

describe("MemoryJournal and Projection", () => {
	const threadId = asThreadId("th_mem_test");
	const turnId = asTurnId("turn_001");

	test("assigns monotonic sequence and generates 3-tier receipts", async () => {
		const writer = new MemoryJournalWriter(threadId);

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

		const receipt1 = await writer.append([draft1, draft2]);
		expect(receipt1.level).toBe("accepted");
		expect(receipt1.seq).toBe(2);
		expect(receipt1.eventId).toBe("evt_th_mem_test_2");

		const persistedReceipt = await writer.persist();
		expect(persistedReceipt.level).toBe("persisted");
		expect(persistedReceipt.watermarkSeq).toBe(2);

		const durableReceipt = await writer.flush();
		expect(durableReceipt.level).toBe("power_loss_durable");
		expect(durableReceipt.durableSeq).toBe(2);

		expect(writer.committedEnvelopes.length).toBe(2);
		expect(writer.committedEnvelopes[0]!.seq).toBe(1);
		expect(writer.committedEnvelopes[1]!.seq).toBe(2);
	});

	test("MemoryJournalStore open and load with afterSeq filtering", async () => {
		const store = new MemoryJournalStore();
		const writer = await store.open(threadId);

		const draft: JournalDraft = {
			schemaVersion: 1,
			threadId,
			turnId,
			record: {
				recordType: "runtime_fact",
				fact: { factType: "turn", turnId, status: "completed", terminal: true } as TurnFact,
			},
		};

		await writer.append([draft]);
		await writer.persist();

		const loadedAll: any[] = [];
		for await (const env of store.load(threadId)) {
			loadedAll.push(env);
		}
		expect(loadedAll.length).toBe(1);
		expect(loadedAll[0].seq).toBe(1);

		const loadedAfter1: any[] = [];
		for await (const env of store.load(threadId, 1)) {
			loadedAfter1.push(env);
		}
		expect(loadedAfter1.length).toBe(0);
	});

	test("projectThreadSnapshot reconstructs state from envelopes", async () => {
		const writer = new MemoryJournalWriter(threadId);

		await writer.append([
			{
				schemaVersion: 1,
				threadId,
				turnId,
				record: {
					recordType: "runtime_fact",
					fact: { factType: "turn", turnId, status: "admitted" } as TurnFact,
				},
			},
			{
				schemaVersion: 1,
				threadId,
				turnId,
				record: {
					recordType: "runtime_fact",
					fact: { factType: "turn", turnId, status: "completed", terminal: true } as TurnFact,
				},
			},
		]);

		const snapshot = projectThreadSnapshot(threadId, writer.committedEnvelopes);
		expect(snapshot.threadId).toBe(threadId);
		expect(snapshot.durableWatermarkSeq).toBe(2);
		expect(snapshot.durableStatus).toBe("active");
		expect(snapshot.residencyStatus).toBe("idle");
		// ActiveTurn should be cleared because it completed
		expect(snapshot.activeTurn).toBeUndefined();
	});
});
