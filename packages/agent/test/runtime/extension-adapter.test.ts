import { describe, expect, test } from "vitest";
import {
	adaptLegacyExtension,
	type LegacyExtensionContext,
	type Plugin,
	type PluginContext,
	PluginHost,
	TOOLS_SERVICE,
	type ToolCatalog,
} from "../../src/runtime/index.ts";

describe("Legacy Pi Extension Compatibility Adapter", () => {
	test("adapts legacy Pi extension factory and registers tool in PluginHost", async () => {
		const host = new PluginHost();
		const registeredTools: any[] = [];

		// 1. Tool provider plugin providing TOOLS_SERVICE
		const toolCatalogPlugin: Plugin = {
			manifest: {
				id: "tool-catalog-plugin",
				version: "1.0.0",
				provides: [{ id: TOOLS_SERVICE.id, version: "1.0.0" }],
			},
			activate: (ctx: PluginContext) => {
				const catalog: ToolCatalog = {
					registerTool: (tool: any) => {
						registeredTools.push(tool);
					},
					getTools: () => registeredTools,
				};
				ctx.provide(TOOLS_SERVICE, catalog);
			},
		};

		// 2. Legacy Pi extension
		const legacyExtensionFactory = (ctx: LegacyExtensionContext) => {
			ctx.registerTool({
				name: "legacy_calc",
				description: "Legacy calculator tool",
				execute: async () => ({ result: "calculated" }),
			});
		};

		const adaptedPlugin = adaptLegacyExtension("calc-extension", legacyExtensionFactory);

		// 3. Start host with both plugins
		await host.start([toolCatalogPlugin, adaptedPlugin]);

		expect(registeredTools.length).toBe(1);
		expect(registeredTools[0].name).toBe("legacy_calc");

		await host.stop();
	});
});
