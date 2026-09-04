import { describe, expect, test } from "vitest";
import {
	createRuntimeScope,
	createServiceToken,
	createTaskScope,
	createThreadScope,
	createTurnScope,
} from "../../src/runtime/index.ts";

describe("Hierarchical Scopes and Cascading LIFO Disposal", () => {
	const S_GLOBAL = createServiceToken<{ env: string }>("global.env");
	const S_THREAD = createServiceToken<{ threadId: string }>("thread.id");

	test("resolves services upwards and disposes downward in reverse LIFO order", async () => {
		const disposedEvents: string[] = [];

		const runtimeScope = createRuntimeScope();
		runtimeScope.serviceScope.provide(S_GLOBAL, { env: "production" });
		runtimeScope.effectScope.add(() => {
			disposedEvents.push("runtime");
		});

		const threadScope = createThreadScope(runtimeScope, "th_001");
		threadScope.serviceScope.provide(S_THREAD, { threadId: "th_001" });
		threadScope.effectScope.add(() => {
			disposedEvents.push("thread");
		});

		const turnScope = createTurnScope(threadScope, "turn_001");
		turnScope.effectScope.add(() => {
			disposedEvents.push("turn");
		});

		const taskScope = createTaskScope(turnScope, "task_001");
		taskScope.effectScope.add(() => {
			disposedEvents.push("task");
		});

		// 1. Upward service resolution
		expect(taskScope.serviceScope.require(S_GLOBAL).env).toBe("production");
		expect(taskScope.serviceScope.require(S_THREAD).threadId).toBe("th_001");
		expect(turnScope.serviceScope.require(S_THREAD).threadId).toBe("th_001");

		// 2. Cascading LIFO disposal starting from threadScope
		await threadScope.dispose();

		// Children disposed before parent (task -> turn -> thread)
		expect(disposedEvents).toEqual(["task", "turn", "thread"]);
		expect(threadScope.disposed).toBe(true);
		expect(turnScope.disposed).toBe(true);
		expect(taskScope.disposed).toBe(true);

		// Runtime scope is still active
		expect(runtimeScope.disposed).toBe(false);
		expect(runtimeScope.serviceScope.require(S_GLOBAL).env).toBe("production");

		await runtimeScope.dispose();
		expect(disposedEvents).toEqual(["task", "turn", "thread", "runtime"]);
	});
});
