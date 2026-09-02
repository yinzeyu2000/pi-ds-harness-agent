import { describe, expect, it, vi } from "vitest";
import { LiveEventBus, runMonotonicGuards, runParallelBarrier, runWaterfall } from "../src/events.ts";
import { MemoryFactStore, ObservableFactLog, ProjectionRegistry } from "../src/projections.ts";

describe("event domains", () => {
	it("isolates observer errors", async () => {
		const failures: unknown[] = [];
		const events = new LiveEventBus<{ update: number }>((failure) => failures.push(failure));
		const received: number[] = [];
		events.on("update", () => {
			throw new Error("observer failed");
		});
		events.on("update", (value) => {
			received.push(value);
		});
		await events.emit("update", 7);
		expect(received).toEqual([7]);
		expect(failures).toHaveLength(1);
	});

	it("supports next-once waterfall, barriers, and monotonic deny", async () => {
		const value = await runWaterfall({}, 1, [
			async (_context, current, next) => next(current + 1),
			async (_context, current, next) => next(current * 3),
		]);
		expect(value).toBe(6);
		expect(await runParallelBarrier([async () => 1, async () => 2])).toEqual([1, 2]);
		const later = vi.fn(() => ({ decision: "allow" as const }));
		expect(await runMonotonicGuards({}, [() => ({ decision: "deny", reason: "policy" }), later])).toEqual({
			decision: "deny",
			reason: "policy",
		});
		expect(later).not.toHaveBeenCalled();
	});
});

describe("canonical facts and projections", () => {
	it("publishes only after durable append and replays deterministically", async () => {
		const store = new MemoryFactStore<{ delta: number }>();
		const log = new ObservableFactLog(store);
		const observedCounts: number[] = [];
		log.observe(async () => {
			observedCounts.push((await store.readAll()).length);
		});
		await log.append({ delta: 2 });
		await log.append({ delta: 3 });
		expect(observedCounts).toEqual([1, 2]);

		const projections = new ProjectionRegistry<{ delta: number }>();
		projections.register({ id: "sum", initial: () => 0, reduce: (state, fact) => state + fact.delta });
		const facts = await log.readAll();
		expect(projections.replay<number>("sum", facts)).toBe(5);
		expect(projections.replay<number>("sum", facts)).toBe(5);
	});
});
