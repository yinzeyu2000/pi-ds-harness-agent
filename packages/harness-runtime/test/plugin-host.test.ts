import { describe, expect, it } from "vitest";
import {
	PluginActivationError,
	type PluginContext,
	PluginDependencyError,
	PluginHost,
	resolvePluginOrder,
} from "../src/plugin-host.ts";
import { createServiceToken, ServiceConflictError } from "../src/services.ts";

const VALUE = createServiceToken<number>("test.value");
const RESULT = createServiceToken<string>("test.result");

describe("PluginHost", () => {
	it("orders dependencies and isolates runtime services", async () => {
		const provider = {
			manifest: { id: "provider", version: "1", provides: [VALUE] },
			activate(context: PluginContext) {
				context.provide(VALUE, 42);
			},
		};
		const consumer = {
			manifest: { id: "consumer", version: "1", provides: [RESULT], requires: [VALUE] },
			activate(context: PluginContext) {
				context.provide(RESULT, String(context.require(VALUE)));
			},
		};
		const first = new PluginHost();
		const second = new PluginHost();
		await first.start([
			{ plugin: consumer, config: undefined },
			{ plugin: provider, config: undefined },
		]);
		expect(first.require(RESULT)).toBe("42");
		expect(second.get(RESULT)).toBeUndefined();
		await first.stop();
		expect(first.serviceCount).toBe(0);
	});

	it("rejects conflicts, missing services, and dependency cycles", () => {
		const plugin = (id: string, provides = [VALUE], requires: typeof provides = []) => ({
			manifest: { id, version: "1", provides, requires },
			activate() {},
		});
		expect(() =>
			resolvePluginOrder([
				{ plugin: plugin("a"), config: undefined },
				{ plugin: plugin("b"), config: undefined },
			]),
		).toThrow(ServiceConflictError);
		expect(() => resolvePluginOrder([{ plugin: plugin("a", [], [VALUE]), config: undefined }])).toThrow(
			PluginDependencyError,
		);
		const A = createServiceToken<number>("a");
		const B = createServiceToken<number>("b");
		expect(() =>
			resolvePluginOrder([
				{ plugin: plugin("a", [A], [B]), config: undefined },
				{ plugin: plugin("b", [B], [A]), config: undefined },
			]),
		).toThrow(/cycle/);
	});

	it("rolls effects back in LIFO order after activation failure", async () => {
		const disposed: string[] = [];
		const host = new PluginHost();
		await expect(
			host.start([
				{
					plugin: {
						manifest: { id: "bad", version: "1" },
						async activate(context) {
							await context.effect(() => () => {
								disposed.push("first");
							});
							await context.effect(() => () => {
								disposed.push("second");
							});
							throw new Error("boom");
						},
					},
					config: undefined,
				},
			]),
		).rejects.toBeInstanceOf(PluginActivationError);
		expect(disposed).toEqual(["second", "first"]);
		expect(host.activePluginCount).toBe(0);
	});

	it("aborts plugin scopes before disposal and makes disposal idempotent", async () => {
		let signal: AbortSignal | undefined;
		let disposed = 0;
		const host = new PluginHost();
		await host.start([
			{
				plugin: {
					manifest: { id: "resource", version: "1" },
					activate(context) {
						signal = context.signal;
						return () => {
							disposed++;
						};
					},
				},
				config: undefined,
			},
		]);
		await host.stop();
		await host.stop();
		expect(signal?.aborted).toBe(true);
		expect(disposed).toBe(1);
	});
});
