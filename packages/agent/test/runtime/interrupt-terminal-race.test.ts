import {
	asClientRequestId,
	asControllerEpoch,
	asRuntimeGeneration,
	asThreadId,
	type WireEventEnvelope,
} from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import {
	type AgentDriver,
	type DriverRunOptions,
	type DriverRunResult,
	MemoryJournalWriter,
	ThreadRuntimeImpl,
	type TurnFact,
} from "../../src/runtime/index.ts";

class RaceDriver implements AgentDriver {
	readonly name = "RaceDriver";
	private readonly delayMs: number;

	constructor(delayMs = 1) {
		this.delayMs = delayMs;
	}

	async run(options: DriverRunOptions): Promise<DriverRunResult> {
		await new Promise((r) => setTimeout(r, this.delayMs));
		if (options.signal.aborted) {
			return { turnId: options.turnId, outcome: "interrupted" };
		}
		return { turnId: options.turnId, outcome: "completed" };
	}
}

describe("100-Iteration Interrupt vs Complete Race", () => {
	test("100 race iterations never produce dual terminal states or corrupt facts", async () => {
		const iterations = 100;
		const epoch = asControllerEpoch(1);

		for (let i = 0; i < iterations; i++) {
			const threadId = asThreadId(`th_race_${i}`);
			const writer = new MemoryJournalWriter(threadId);
			const delay = (i % 5) + 1; // 1 to 5 ms delay
			const driver = new RaceDriver(delay);
			const runtime = new ThreadRuntimeImpl(threadId, asRuntimeGeneration(1), writer, driver);
			await runtime.acquireController("ctrl-race");

			const emittedTerminals: WireEventEnvelope[] = [];
			runtime.subscribe((ev) => {
				if (ev.type === "turn.completed" || ev.type === "turn.interrupted" || ev.type === "turn.failed") {
					emittedTerminals.push(ev);
				}
			});

			const clientReqId = asClientRequestId(`req_race_${i}`);
			const turn = await runtime.startTurn("Race prompt", clientReqId, epoch, "user-race");

			// Concurrently trigger interrupt after random jitter
			const interruptJitter = (i * 7) % 6; // 0 to 5 ms
			await new Promise((r) => setTimeout(r, interruptJitter));
			void runtime.interruptTurn(turn.turnId, epoch, "Race interrupt");

			// Wait for turn to settle completely
			let retries = 0;
			while (runtime.activeTurn !== undefined && retries++ < 50) {
				await new Promise((r) => setTimeout(r, 5));
			}

			// Invariant: Exactly one terminal wire event emitted
			expect(emittedTerminals.length).toBe(1);
			const terminalType = emittedTerminals[0]!.type;
			expect(["turn.completed", "turn.interrupted", "turn.failed"]).toContain(terminalType);

			// Invariant: Exactly one terminal fact in Journal
			const terminalFacts = writer.committedEnvelopes
				.filter((e) => e.record.recordType === "runtime_fact" && (e.record.fact as any).terminal)
				.map((e) => (e.record as any).fact as TurnFact);

			expect(terminalFacts.length).toBe(1);
			expect(["completed", "interrupted", "failed"]).toContain(terminalFacts[0]!.status);
		}
	});
});
