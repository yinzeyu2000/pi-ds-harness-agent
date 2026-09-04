import { asClientRequestId, asControllerEpoch, asRuntimeGeneration, asThreadId } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import {
	type AgentDriver,
	BaseRuntimeError,
	type DriverRunOptions,
	type DriverRunResult,
	MemoryJournalWriter,
	ThreadRuntimeImpl,
} from "../../src/runtime/index.ts";

class HangingDriver implements AgentDriver {
	readonly name = "HangingDriver";
	private resolveTurn?: (res: DriverRunResult) => void;

	async run(_options: DriverRunOptions): Promise<DriverRunResult> {
		return new Promise<DriverRunResult>((res) => {
			this.resolveTurn = res;
		});
	}

	finish(turnId: any): void {
		if (this.resolveTurn) {
			this.resolveTurn({ turnId, outcome: "completed" });
		}
	}
}

describe("ActiveTurn Exclusivity Invariant", () => {
	test("rejects second turn when first turn is still active", async () => {
		const threadId = asThreadId("th_excl_test");
		const writer = new MemoryJournalWriter(threadId);
		const driver = new HangingDriver();
		const runtime = new ThreadRuntimeImpl(threadId, asRuntimeGeneration(1), writer, driver);

		const epoch = asControllerEpoch(1);
		await runtime.acquireController("ctrl-1");

		// Start Turn 1
		const turn1 = await runtime.startTurn("First Prompt", asClientRequestId("req_1"), epoch, "user-1");

		expect(turn1.phase).toBe("admitted");
		expect(runtime.activeTurn?.turnId).toBe(turn1.turnId);

		// Attempt to start Turn 2 while Turn 1 is running
		let conflictError: BaseRuntimeError | undefined;
		try {
			await runtime.startTurn("Second Prompt", asClientRequestId("req_2"), epoch, "user-1");
		} catch (err) {
			if (err instanceof BaseRuntimeError) {
				conflictError = err;
			}
		}

		expect(conflictError).toBeDefined();
		expect(conflictError?.code).toBe("ACTIVE_TURN_CONFLICT");

		// Complete Turn 1
		driver.finish(turn1.turnId);
		// Wait for terminal settlement
		await new Promise((r) => setTimeout(r, 50));

		expect(runtime.activeTurn).toBeUndefined();

		// Now Turn 2 should succeed
		const turn2 = await runtime.startTurn("Second Prompt", asClientRequestId("req_2_retry"), epoch, "user-1");
		expect(turn2.phase).toBe("admitted");
		expect(runtime.activeTurn?.turnId).toBe(turn2.turnId);

		driver.finish(turn2.turnId);
		await new Promise((r) => setTimeout(r, 50));
	});
});
