import { createServiceToken, type HarnessPlugin, type ServiceToken } from "@pi-ds/harness-runtime/plugin-sdk";
import { createEventBus, type EventBusController } from "../event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "./loader.ts";
import type { Extension, ExtensionFactory, ExtensionRuntime } from "./types.ts";

export interface LegacyExtensionContribution {
	extension: Extension;
	runtime: ExtensionRuntime;
	eventBus: EventBusController;
}

export interface LegacyExtensionAdapterOptions {
	id: string;
	version: string;
	factory: ExtensionFactory;
	cwd: string;
	service: ServiceToken<LegacyExtensionContribution>;
	extensionPath?: string;
}

export interface LegacyExtensionSpec {
	factory: ExtensionFactory;
	extensionPath?: string;
}

export interface LegacyExtensionSetContribution {
	extensions: readonly Extension[];
	runtime: ExtensionRuntime;
	eventBus: EventBusController;
}

export interface LegacyExtensionSetAdapterOptions {
	id: string;
	version: string;
	cwd: string;
	extensions: readonly LegacyExtensionSpec[];
	service: ServiceToken<LegacyExtensionSetContribution>;
}

export interface LegacyExtensionSetPlugin extends HarnessPlugin<undefined> {
	getContribution(): LegacyExtensionSetContribution;
}

export const LEGACY_EXTENSIONS_SERVICE = createServiceToken<LegacyExtensionSetContribution>(
	"pi-ds.coding.legacy-extensions",
);

export function createLegacyExtensionPlugin(options: LegacyExtensionAdapterOptions): HarnessPlugin<undefined> {
	return {
		manifest: { id: options.id, version: options.version, provides: [options.service] },
		async activate(context) {
			const eventBus = createEventBus();
			const runtime = createExtensionRuntime();
			try {
				const extension = await loadExtensionFromFactory(
					options.factory,
					options.cwd,
					eventBus,
					runtime,
					options.extensionPath ?? `<harness:${options.id}>`,
				);
				context.provide(options.service, { extension, runtime, eventBus });
			} catch (error) {
				runtime.invalidate(`Legacy extension ${options.id} failed during Plugin Scope activation`);
				eventBus.clear();
				throw error;
			}
			return () => {
				runtime.invalidate(`Legacy extension ${options.id} Plugin Scope was disposed`);
				eventBus.clear();
			};
		},
	};
}

export function createLegacyExtensionSetPlugin(options: LegacyExtensionSetAdapterOptions): LegacyExtensionSetPlugin {
	let activeContribution: LegacyExtensionSetContribution | undefined;
	return {
		manifest: { id: options.id, version: options.version, provides: [options.service] },
		async activate(context) {
			const eventBus = createEventBus();
			const runtime = createExtensionRuntime();
			try {
				const extensions: Extension[] = [];
				for (const [index, specification] of options.extensions.entries()) {
					extensions.push(
						await loadExtensionFromFactory(
							specification.factory,
							options.cwd,
							eventBus,
							runtime,
							specification.extensionPath ?? `<harness:${options.id}:${index}>`,
						),
					);
				}
				activeContribution = {
					extensions: Object.freeze(extensions),
					runtime,
					eventBus,
				};
				context.provide(options.service, activeContribution);
			} catch (error) {
				activeContribution = undefined;
				runtime.invalidate(`Legacy extension set ${options.id} failed during Plugin Scope activation`);
				eventBus.clear();
				throw error;
			}
			return () => {
				runtime.invalidate(`Legacy extension set ${options.id} Plugin Scope was disposed`);
				eventBus.clear();
				activeContribution = undefined;
			};
		},
		getContribution() {
			if (!activeContribution) throw new Error(`Legacy extension set ${options.id} is not active`);
			return activeContribution;
		},
	};
}
