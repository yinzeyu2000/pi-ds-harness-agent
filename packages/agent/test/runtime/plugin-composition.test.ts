import { describe, expect, test } from "vitest";
import {
	createServiceToken,
	type Plugin,
	PluginActivationError,
	type PluginContext,
	PluginDependencyError,
	PluginHost,
} from "../../src/runtime/index.ts";

describe("M4 Plugin Composition, Semver DAG, Rollback, and Isolation", () => {
	const S1 = createServiceToken<{ value: number }>("test.s1");
	const S2 = createServiceToken<{ name: string }>("test.s2");

	test("resolves DAG with matching semver version range", async () => {
		const host = new PluginHost();

		const p1: Plugin = {
			manifest: {
				id: "provider-plugin",
				version: "1.2.3",
				provides: [{ id: S1.id, version: "1.2.3" }],
			},
			activate: (ctx: PluginContext) => {
				ctx.provide(S1, { value: 42 });
			},
		};

		const p2: Plugin = {
			manifest: {
				id: "consumer-plugin",
				version: "1.0.0",
				requires: [{ id: S1.id, versionRange: "^1.0.0" }],
			},
			activate: (ctx: PluginContext) => {
				const s1 = ctx.require(S1);
				expect(s1.value).toBe(42);
			},
		};

		await host.start([p2, p1]);
		expect(host.activatedCount).toBe(2);
		await host.stop();
	});

	test("rejects incompatible semver version range during DAG resolution", async () => {
		const host = new PluginHost();

		const p1: Plugin = {
			manifest: {
				id: "v2-provider",
				version: "2.0.0",
				provides: [{ id: S1.id, version: "2.0.0" }],
			},
			activate: (ctx: PluginContext) => {
				ctx.provide(S1, { value: 200 });
			},
		};

		const p2: Plugin = {
			manifest: {
				id: "v1-consumer",
				version: "1.0.0",
				requires: [{ id: S1.id, versionRange: "^1.0.0" }],
			},
			activate: () => {},
		};

		await expect(host.start([p1, p2])).rejects.toThrow(PluginDependencyError);
	});

	test("transactional activation rollback returns resources to 0 on mid-flight failure", async () => {
		const host = new PluginHost();
		let activeResources = 0;

		const p1: Plugin = {
			manifest: {
				id: "plugin-1",
				version: "1.0.0",
				provides: [{ id: S1.id }],
			},
			activate: (ctx: PluginContext) => {
				activeResources++;
				ctx.defer(() => {
					activeResources--;
				});
				ctx.provide(S1, { value: 1 });
			},
		};

		const p2: Plugin = {
			manifest: {
				id: "plugin-2-faulty",
				version: "1.0.0",
				requires: [{ id: S1.id }],
			},
			activate: (ctx: PluginContext) => {
				activeResources++;
				ctx.defer(() => {
					activeResources--;
				});
				throw new Error("Activation explosive failure in plugin-2");
			},
		};

		await expect(host.start([p1, p2])).rejects.toThrow(PluginActivationError);

		// Verified exit criteria: resources return to zero!
		expect(activeResources).toBe(0);
		expect(host.activatedCount).toBe(0);
		expect(host.isStarted).toBe(false);
	});

	test("multiple disposal errors are aggregated into AggregateError", async () => {
		const host = new PluginHost();

		const p1: Plugin = {
			manifest: { id: "p1", version: "1.0.0" },
			activate: (ctx: PluginContext) => {
				ctx.defer(() => {
					throw new Error("Disposal error 1");
				});
				ctx.defer(() => {
					throw new Error("Disposal error 2");
				});
			},
		};

		await host.start([p1]);
		await expect(host.stop()).rejects.toThrow(AggregateError);
	});

	test("two runtime instances have zero cross-contamination", async () => {
		const hostA = new PluginHost();
		const hostB = new PluginHost();

		const pA: Plugin = {
			manifest: { id: "pA", version: "1.0.0", provides: [{ id: S2.id }] },
			activate: (ctx: PluginContext) => {
				ctx.provide(S2, { name: "Instance A" });
			},
		};

		const pB: Plugin = {
			manifest: { id: "pB", version: "1.0.0", provides: [{ id: S2.id }] },
			activate: (ctx: PluginContext) => {
				ctx.provide(S2, { name: "Instance B" });
			},
		};

		await hostA.start([pA]);
		await hostB.start([pB]);

		expect(hostA.serviceScope.require(S2).name).toBe("Instance A");
		expect(hostB.serviceScope.require(S2).name).toBe("Instance B");

		await hostA.stop();
		// Stopping hostA leaves hostB fully functional
		expect(hostB.serviceScope.require(S2).name).toBe("Instance B");
		await hostB.stop();
	});
});
