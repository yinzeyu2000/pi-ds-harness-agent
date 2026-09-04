import { describe, expect, test } from "vitest";
import { createServiceToken, type Plugin, PluginActivationError, PluginHost } from "../../src/runtime/index.ts";
import { CordisSpikeHost } from "../../src/runtime/plugin/cordis-spike/cordis-adapter.ts";

describe("Cordis Spike vs Self-Host PluginHost Comparative Conformance", () => {
	const TokenX = createServiceToken<{ msg: string }>("svc-x");
	const TokenY = createServiceToken<{ num: number }>("svc-y");

	test("both pass basic service resolution and LIFO shutdown", async () => {
		const selfHost = new PluginHost();
		const cordisHost = new CordisSpikeHost();

		const selfDispose: string[] = [];
		const cordisDispose: string[] = [];

		const createPlugins = (disposals: string[]): Plugin[] => [
			{
				manifest: { id: "px", version: "1.0.0", provides: [{ id: "svc-x" }] },
				activate: (ctx) => {
					ctx.provide(TokenX, { msg: "hello" });
					ctx.defer(() => {
						disposals.push("px");
					});
				},
			},
			{
				manifest: { id: "py", version: "1.0.0", requires: [{ id: "svc-x" }], provides: [{ id: "svc-y" }] },
				activate: (ctx) => {
					ctx.provide(TokenY, { num: 99 });
					ctx.defer(() => {
						disposals.push("py");
					});
				},
			},
		];

		// SelfHost
		await selfHost.start(createPlugins(selfDispose));
		expect(selfHost.serviceScope.require(TokenX).msg).toBe("hello");
		expect(selfHost.serviceScope.require(TokenY).num).toBe(99);
		await selfHost.stop();
		expect(selfDispose).toEqual(["py", "px"]);

		// CordisSpikeHost
		await cordisHost.start(createPlugins(cordisDispose));
		expect(cordisHost.get(TokenX)?.msg).toBe("hello");
		expect(cordisHost.get(TokenY)?.num).toBe(99);
		await cordisHost.stop();
		expect(cordisDispose).toEqual(["py", "px"]);
	});

	test("both rollback cleanly on activation error", async () => {
		const selfHost = new PluginHost();
		const cordisHost = new CordisSpikeHost();

		const selfCleaned: string[] = [];
		const cordisCleaned: string[] = [];

		const createFailingPlugins = (cleaned: string[]): Plugin[] => [
			{
				manifest: { id: "ok-plugin", version: "1.0.0", provides: [{ id: "svc-x" }] },
				activate: (ctx) => {
					ctx.provide(TokenX, { msg: "ok" });
					ctx.defer(() => {
						cleaned.push("ok-plugin");
					});
				},
			},
			{
				manifest: { id: "bad-plugin", version: "1.0.0", requires: [{ id: "svc-x" }] },
				activate: (ctx) => {
					ctx.defer(() => {
						cleaned.push("bad-plugin-partial");
					});
					throw new Error("Activation crash");
				},
			},
		];

		await expect(selfHost.start(createFailingPlugins(selfCleaned))).rejects.toThrow(PluginActivationError);
		expect(selfCleaned).toEqual(["bad-plugin-partial", "ok-plugin"]);

		await expect(cordisHost.start(createFailingPlugins(cordisCleaned))).rejects.toThrow(PluginActivationError);
		expect(cordisCleaned).toEqual(["bad-plugin-partial", "ok-plugin"]);
	});
});
