import type { Plugin, PluginContext } from "./context.ts";
import type { PluginManifest } from "./manifest.ts";
import { TOOLS_SERVICE, type ToolCatalog } from "./services.ts";

export interface LegacyExtensionContext {
	registerTool(tool: any): void;
	registerCommand?(name: string, handler: (...args: any[]) => any): void;
	on?(event: string, listener: (...args: any[]) => void): void;
	readonly signal?: AbortSignal;
}

export type LegacyExtensionFactory = (ctx: LegacyExtensionContext) => void | Promise<void>;

export function adaptLegacyExtension(name: string, factory: LegacyExtensionFactory, version = "1.0.0"): Plugin {
	const pluginId = `legacy_ext_${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
	const manifest: PluginManifest = {
		id: pluginId,
		version,
		optional: [{ id: TOOLS_SERVICE.id }],
		provides: [{ id: `pi.extension.${name}`, version }],
	};

	return {
		manifest,
		activate: async (ctx: PluginContext) => {
			const toolCatalog = ctx.get(TOOLS_SERVICE) as ToolCatalog | undefined;

			const legacyCtx: LegacyExtensionContext = {
				signal: ctx.signal,
				registerTool: (tool: any) => {
					if (toolCatalog) {
						toolCatalog.registerTool(tool);
					}
				},
				registerCommand: (_cmdName: string, _handler: (...args: any[]) => any) => {
					// Legacy command registration placeholder
				},
				on: (_event: string, _listener: (...args: any[]) => void) => {
					// Legacy event listener placeholder
				},
			};

			await factory(legacyCtx);
		},
	};
}
