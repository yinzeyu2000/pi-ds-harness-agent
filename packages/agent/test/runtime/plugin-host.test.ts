import { describe, expect, test } from "vitest";
import {
	createServiceToken,
	type Plugin,
	PluginActivationError,
	PluginDependencyError,
	PluginHost,
	ServiceConflictError,
	ServiceScope,
} from "../../src/runtime/index.ts";

describe("PluginHost Conformance", () => {
	const TokenA = createServiceToken<{ value: string }>("service-a");
	const TokenB = createServiceToken<{ count: number }>("service-b");
	const TokenC = createServiceToken<{ tag: string }>("service-c");

	test("activates plugins in topological order", async () => {
		const order: string[] = [];
		const host = new PluginHost();

		const pluginB: Plugin = {
			manifest: {
				id: "plugin-b",
				version: "1.0.0",
				requires: [{ id: "service-a" }],
				provides: [{ id: "service-b" }],
			},
			activate: (ctx) => {
				order.push("plugin-b");
				const a = ctx.require(TokenA);
				expect(a.value).toBe("from-a");
				ctx.provide(TokenB, { count: 42 });
			},
		};

		const pluginA: Plugin = {
			manifest: {
				id: "plugin-a",
				version: "1.0.0",
				provides: [{ id: "service-a" }],
			},
			activate: (ctx) => {
				order.push("plugin-a");
				ctx.provide(TokenA, { value: "from-a" });
			},
		};

		// Passed in reverse order: pluginB first, pluginA second
		await host.start([pluginB, pluginA]);

		expect(order).toEqual(["plugin-a", "plugin-b"]);
		expect(host.serviceScope.require(TokenB).count).toBe(42);
		await host.stop();
	});

	test("detects and rejects dependency cycles", async () => {
		const host = new PluginHost();

		const plugin1: Plugin = {
			manifest: {
				id: "p1",
				version: "1.0.0",
				provides: [{ id: "service-a" }],
				requires: [{ id: "service-b" }],
			},
			activate: () => {},
		};

		const plugin2: Plugin = {
			manifest: {
				id: "p2",
				version: "1.0.0",
				provides: [{ id: "service-b" }],
				requires: [{ id: "service-a" }],
			},
			activate: () => {},
		};

		await expect(host.start([plugin1, plugin2])).rejects.toThrow(PluginDependencyError);
	});

	test("rejects missing required service", async () => {
		const host = new PluginHost();

		const plugin: Plugin = {
			manifest: {
				id: "isolated",
				version: "1.0.0",
				requires: [{ id: "missing-service" }],
			},
			activate: () => {},
		};

		await expect(host.start([plugin])).rejects.toThrow(PluginDependencyError);
	});

	test("rejects duplicate providers for same service", async () => {
		const host = new PluginHost();

		const p1: Plugin = {
			manifest: {
				id: "p1",
				version: "1.0.0",
				provides: [{ id: "service-a" }],
			},
			activate: (ctx) => {
				ctx.provide(TokenA, { value: "first" });
			},
		};

		const p2: Plugin = {
			manifest: {
				id: "p2",
				version: "1.0.0",
				provides: [{ id: "service-a" }],
			},
			activate: (ctx) => {
				ctx.provide(TokenA, { value: "second" });
			},
		};

		await expect(host.start([p1, p2])).rejects.toThrow(ServiceConflictError);
	});

	test("rolls back already activated plugins on mid-activation failure", async () => {
		const host = new PluginHost();
		const disposed: string[] = [];

		const p1: Plugin = {
			manifest: {
				id: "p1",
				version: "1.0.0",
				provides: [{ id: "service-a" }],
			},
			activate: (ctx) => {
				ctx.provide(TokenA, { value: "a" });
				ctx.defer(() => {
					disposed.push("p1");
				});
			},
		};

		const p2: Plugin = {
			manifest: {
				id: "p2",
				version: "1.0.0",
				requires: [{ id: "service-a" }],
			},
			activate: (ctx) => {
				ctx.defer(() => {
					disposed.push("p2-partial");
				});
				throw new Error("P2 exploded");
			},
		};

		await expect(host.start([p1, p2])).rejects.toThrow(PluginActivationError);

		// Rollback must dispose p2's partial registrations, then p1's registrations in reverse order
		expect(disposed).toEqual(["p2-partial", "p1"]);
		expect(host.activatedCount).toBe(0);
	});

	test("strict LIFO disposal order on shutdown", async () => {
		const host = new PluginHost();
		const disposeOrder: string[] = [];

		const p1: Plugin = {
			manifest: {
				id: "p1",
				version: "1.0.0",
				provides: [{ id: "service-a" }],
			},
			activate: (ctx) => {
				ctx.provide(TokenA, { value: "a" });
				ctx.defer(() => {
					disposeOrder.push("p1");
				});
			},
		};

		const p2: Plugin = {
			manifest: {
				id: "p2",
				version: "1.0.0",
				requires: [{ id: "service-a" }],
				provides: [{ id: "service-b" }],
			},
			activate: (ctx) => {
				ctx.provide(TokenB, { count: 1 });
				ctx.defer(() => {
					disposeOrder.push("p2");
				});
			},
		};

		await host.start([p1, p2]);
		await host.stop();

		// LIFO: p2 disposed before p1
		expect(disposeOrder).toEqual(["p2", "p1"]);
	});

	test("hierarchical ServiceScope resolution: RuntimeScope -> ThreadScope -> TurnScope -> TaskScope", () => {
		const runtimeScope = new ServiceScope("runtime");
		const threadScope = runtimeScope.createChild("thread");
		const turnScope = threadScope.createChild("turn");
		const taskScope = turnScope.createChild("task");

		runtimeScope.provide(TokenA, { value: "global" });
		threadScope.provide(TokenB, { count: 100 });
		turnScope.provide(TokenC, { tag: "turn-local" });

		// TaskScope resolves tokens upwards
		expect(taskScope.require(TokenA).value).toBe("global");
		expect(taskScope.require(TokenB).count).toBe(100);
		expect(taskScope.require(TokenC).tag).toBe("turn-local");

		// Sibling or parent cannot see child scope
		expect(runtimeScope.get(TokenB)).toBeUndefined();
		expect(runtimeScope.get(TokenC)).toBeUndefined();
		expect(threadScope.get(TokenC)).toBeUndefined();
	});
});
