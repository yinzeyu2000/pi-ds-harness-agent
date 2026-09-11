import { PluginHost } from "@pi-ds/harness-runtime";
import { createServiceToken } from "@pi-ds/harness-runtime/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import {
	createLegacyExtensionPlugin,
	createLegacyExtensionSetPlugin,
	type ExtensionAPI,
	type LegacyExtensionContribution,
	type LegacyExtensionSetContribution,
} from "../src/core/extensions/index.ts";

const LEGACY_EXTENSION = createServiceToken<LegacyExtensionContribution>("test.legacy-extension");
const LEGACY_EXTENSION_SET = createServiceToken<LegacyExtensionSetContribution>("test.legacy-extension-set");

describe("legacy Extension Plugin Scope adapter", () => {
	it("makes Plugin Scope the sole owner of the legacy runtime and subscriptions", async () => {
		const observed = vi.fn();
		let api: ExtensionAPI | undefined;
		const plugin = createLegacyExtensionPlugin({
			id: "legacy.example",
			version: "1.0.0",
			cwd: process.cwd(),
			service: LEGACY_EXTENSION,
			factory: (extensionApi) => {
				api = extensionApi;
				extensionApi.registerCommand("hello", { handler: async () => {} });
				extensionApi.events.on("legacy:test", observed);
			},
		});
		const host = new PluginHost();

		await host.start([{ plugin, config: undefined }]);
		const contribution = host.require(LEGACY_EXTENSION);
		expect(contribution.extension.commands.has("hello")).toBe(true);

		contribution.eventBus.emit("legacy:test", { value: 1 });
		await Promise.resolve();
		expect(observed).toHaveBeenCalledOnce();

		await host.stop();
		expect(host.serviceCount).toBe(0);
		expect(() => contribution.runtime.assertActive()).toThrow("Plugin Scope was disposed");
		expect(() => api?.registerCommand("stale", { handler: async () => {} })).toThrow("Plugin Scope was disposed");

		contribution.eventBus.emit("legacy:test", { value: 2 });
		await Promise.resolve();
		expect(observed).toHaveBeenCalledOnce();
	});

	it("rolls back the legacy runtime when its factory fails", async () => {
		const host = new PluginHost();
		const plugin = createLegacyExtensionPlugin({
			id: "legacy.broken",
			version: "1.0.0",
			cwd: process.cwd(),
			service: LEGACY_EXTENSION,
			factory: () => {
				throw new Error("broken extension");
			},
		});

		await expect(host.start([{ plugin, config: undefined }])).rejects.toThrow("Plugin activation failed");
		expect(host.activePluginCount).toBe(0);
		expect(host.serviceCount).toBe(0);
	});

	it("loads and disposes an extension set as one atomic scope", async () => {
		const observed = vi.fn();
		let firstApi: ExtensionAPI | undefined;
		const plugin = createLegacyExtensionSetPlugin({
			id: "legacy.set",
			version: "1.0.0",
			cwd: process.cwd(),
			service: LEGACY_EXTENSION_SET,
			extensions: [
				{
					extensionPath: "<first>",
					factory: (api) => {
						firstApi = api;
						api.registerCommand("first", { handler: async () => {} });
						api.events.on("set:event", observed);
					},
				},
				{
					extensionPath: "<second>",
					factory: (api) => api.registerCommand("second", { handler: async () => {} }),
				},
			],
		});
		const host = new PluginHost();

		await host.start([{ plugin, config: undefined }]);
		const contribution = host.require(LEGACY_EXTENSION_SET);
		expect(plugin.getContribution()).toBe(contribution);
		expect(contribution.extensions.map((extension) => extension.path)).toEqual(["<first>", "<second>"]);
		contribution.eventBus.emit("set:event", { value: 1 });
		await Promise.resolve();
		expect(observed).toHaveBeenCalledOnce();

		await host.stop();
		expect(() => plugin.getContribution()).toThrow("is not active");
		expect(() => firstApi?.registerCommand("stale", { handler: async () => {} })).toThrow(
			"Plugin Scope was disposed",
		);
		contribution.eventBus.emit("set:event", { value: 2 });
		await Promise.resolve();
		expect(observed).toHaveBeenCalledOnce();
	});

	it("rolls back the whole extension set when a later factory fails", async () => {
		let firstApi: ExtensionAPI | undefined;
		const plugin = createLegacyExtensionSetPlugin({
			id: "legacy.broken-set",
			version: "1.0.0",
			cwd: process.cwd(),
			service: LEGACY_EXTENSION_SET,
			extensions: [
				{
					factory: (api) => {
						firstApi = api;
					},
				},
				{
					factory: () => {
						throw new Error("second extension failed");
					},
				},
			],
		});
		const host = new PluginHost();

		await expect(host.start([{ plugin, config: undefined }])).rejects.toThrow("Plugin activation failed");
		expect(host.activePluginCount).toBe(0);
		expect(host.serviceCount).toBe(0);
		expect(() => plugin.getContribution()).toThrow("is not active");
		expect(() => firstApi?.registerCommand("stale", { handler: async () => {} })).toThrow(
			"failed during Plugin Scope activation",
		);
	});
});
