import { asThreadId, asTurnId } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import type { ProcessSpec } from "../../src/runtime/index.ts";
import { ProcessSupervisorImpl } from "../../src/runtime/node.ts";

describe("ProcessSupervisorImpl, Execution Lifecycle, and Termination Protocol", () => {
	const context = {
		threadId: asThreadId("th_proc_test"),
		turnId: asTurnId("turn_proc_test"),
	};

	test("spawns OS process and captures stdout and exit code", async () => {
		const supervisor = new ProcessSupervisorImpl();

		const spec: ProcessSpec = {
			command: process.execPath,
			args: ["-e", 'process.stdout.write("hello from supervisor"); process.exit(0);'],
		};

		const handle = await supervisor.spawn(spec, context);
		const outcome = await handle.wait();

		expect(outcome.exitCode).toBe(0);
		expect(outcome.timedOut).toBe(false);
		expect(outcome.aborted).toBe(false);

		const batch = await supervisor.read(handle.processId);
		const text = batch.chunks.map((c: any) => c.data).join("");
		expect(text).toContain("hello from supervisor");
	});

	test("process timeout triggers termination and sets timedOut flag", async () => {
		const supervisor = new ProcessSupervisorImpl();

		// Process that sleeps for 5 seconds, but timeout is 100ms
		const spec: ProcessSpec = {
			command: process.execPath,
			args: ["-e", "setTimeout(() => process.exit(0), 5000);"],
			timeoutMs: 100,
		};

		const handle = await supervisor.spawn(spec, context);
		const outcome = await handle.wait();

		expect(outcome.timedOut).toBe(true);
		expect(outcome.aborted).toBe(true);
	}, 10000);

	test("terminate executes strict TERM -> KILL -> await protocol and confirms exit", async () => {
		const supervisor = new ProcessSupervisorImpl();

		// Long running process
		const spec: ProcessSpec = {
			command: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000);"],
		};

		const handle = await supervisor.spawn(spec, context);

		// Terminate process explicitly
		const outcome = await supervisor.terminate(handle.processId);

		expect(outcome.aborted).toBe(true);
		expect(outcome.terminationFailed).toBe(false);

		const record = supervisor.registry.get(handle.processId);
		expect(record).toBeDefined();
		expect(record?.status === "killed" || record?.status === "exited").toBe(true);
	}, 10000);

	test("late events from dead ProcessId cannot pollute active processes", async () => {
		const supervisor = new ProcessSupervisorImpl();

		const spec1: ProcessSpec = {
			command: process.execPath,
			args: ["-e", 'console.log("proc 1"); process.exit(0);'],
		};
		const handle1 = await supervisor.spawn(spec1, context);
		await handle1.wait();

		const spec2: ProcessSpec = {
			command: process.execPath,
			args: ["-e", 'console.log("proc 2"); process.exit(0);'],
		};
		const handle2 = await supervisor.spawn(spec2, context);
		await handle2.wait();

		expect(handle1.processId).not.toBe(handle2.processId);

		const batch1 = await supervisor.read(handle1.processId);
		const batch2 = await supervisor.read(handle2.processId);

		expect(batch1.chunks.map((c: any) => c.data).join("")).toContain("proc 1");
		expect(batch2.chunks.map((c: any) => c.data).join("")).toContain("proc 2");
	});
});
