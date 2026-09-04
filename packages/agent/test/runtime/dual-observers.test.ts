import {
	asClientRequestId,
	asControllerEpoch,
	asRuntimeGeneration,
	asThreadId,
	type WireEventEnvelope,
} from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { FakeDriver, MemoryJournalWriter, ThreadRuntimeImpl } from "../../src/runtime/index.ts";

describe("Dual Observers Consistency", () => {
	test("two independent observers receive consistent and identical ordered events", async () => {
		const threadId = asThreadId("th_dual_obs");
		const writer = new MemoryJournalWriter(threadId);
		const driver = new FakeDriver("completed", "all done");
		const runtime = new ThreadRuntimeImpl(threadId, asRuntimeGeneration(1), writer, driver);

		await runtime.acquireController("ctrl-obs");

		const observer1Events: WireEventEnvelope[] = [];
		const observer2Events: WireEventEnvelope[] = [];

		const sub1 = runtime.subscribe((ev) => observer1Events.push(ev));
		const sub2 = runtime.subscribe((ev) => observer2Events.push(ev));

		const clientReqId = asClientRequestId("req_dual_1");
		await runtime.startTurn("Hello dual", clientReqId, asControllerEpoch(1), "user-1");

		// Wait for turn loop to complete
		let retries = 0;
		while (runtime.activeTurn !== undefined && retries++ < 50) {
			await new Promise((r) => setTimeout(r, 10));
		}

		// Verify both observers received the exact same count
		expect(observer1Events.length).toBeGreaterThanOrEqual(2);
		expect(observer1Events.length).toBe(observer2Events.length);

		// Verify both observers received identical event types in identical order
		const types1 = observer1Events.map((e) => e.type);
		const types2 = observer2Events.map((e) => e.type);
		expect(types1).toEqual(types2);

		expect(types1[0]).toBe("turn.admitted");
		expect(types1[1]).toBe("turn.started");
		expect(types1[types1.length - 1]).toBe("turn.completed");

		sub1.dispose();
		sub2.dispose();
	});
});
