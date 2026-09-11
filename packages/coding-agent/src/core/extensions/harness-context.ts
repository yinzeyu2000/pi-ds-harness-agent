import { dirname } from "node:path";
import type { PiAgentDriver } from "@pi-ds/harness-runtime";
import type { ModelRegistry } from "../model-registry.ts";
import type { ReadonlySessionManager } from "../session-manager.ts";
import { getNoOpExtensionUIContext } from "./runner.ts";
import type { BuildSystemPromptOptions, ExtensionCommandContext, ExtensionContext, ExtensionMode } from "./types.ts";

export interface HarnessExtensionContextRuntime {
	driver: PiAgentDriver;
	sessionId: string;
	sessionPath: string;
	getSessionName(): string | undefined;
}

export interface CreateHarnessExtensionContextsOptions {
	cwd: string;
	mode: ExtensionMode;
	modelRegistry: ModelRegistry;
	systemPromptOptions: BuildSystemPromptOptions;
	getRuntime(): HarnessExtensionContextRuntime;
	isProjectTrusted?: boolean;
	onShutdown?: () => void;
}

export function createHarnessExtensionContexts(options: CreateHarnessExtensionContextsOptions): {
	context: () => ExtensionContext;
	commandContext: () => ExtensionCommandContext;
} {
	const sessionManager = createHarnessReadonlySessionManager(options);
	const context = (): ExtensionContext => ({
		ui: getNoOpExtensionUIContext(),
		mode: options.mode,
		hasUI: false,
		cwd: options.cwd,
		sessionManager,
		modelRegistry: options.modelRegistry,
		model: options.getRuntime().driver.model,
		scopedModels: [],
		thinkingLevel: options.getRuntime().driver.thinkingLevel,
		isIdle: () => options.getRuntime().driver.isIdle(),
		isProjectTrusted: () => options.isProjectTrusted ?? false,
		get signal() {
			return options.getRuntime().driver.signal;
		},
		abort: () => options.getRuntime().driver.abort(),
		hasPendingMessages: () => options.getRuntime().driver.hasPendingMessages(),
		shutdown: () => {
			options.getRuntime().driver.abort();
			options.onShutdown?.();
		},
		getContextUsage: () => undefined,
		compact: (compactOptions) => {
			void options
				.getRuntime()
				.driver.compact({ customInstructions: compactOptions?.customInstructions })
				.then((result) => {
					if (!result || !compactOptions?.onComplete) return;
					compactOptions.onComplete({
						summary: result.summary,
						firstKeptEntryId: result.id,
						tokensBefore: result.tokensBefore,
						usage: result.usage,
						details: result.details,
					});
				})
				.catch((error) => compactOptions?.onError?.(error instanceof Error ? error : new Error(String(error))));
		},
		getSystemPrompt: () => options.getRuntime().driver.systemPrompt,
	});
	return {
		context,
		commandContext: () => {
			const command = Object.defineProperties(
				{},
				Object.getOwnPropertyDescriptors(context()),
			) as ExtensionCommandContext;
			command.getSystemPromptOptions = () => options.systemPromptOptions;
			command.waitForIdle = () => options.getRuntime().driver.waitForIdle();
			command.newSession = () => unsupportedCommand("newSession");
			command.fork = () => unsupportedCommand("fork");
			command.navigateTree = async (targetId, navigationOptions) => {
				if (navigationOptions?.summarize) {
					throw new Error("Legacy Extension branch summarization is not supported by Coding Runtime yet");
				}
				await options.getRuntime().driver.navigateTo(targetId);
				return { cancelled: false };
			};
			command.switchSession = () => unsupportedCommand("switchSession");
			command.reload = () => unsupportedCommand("reload");
			return command;
		},
	};
}

function createHarnessReadonlySessionManager(options: CreateHarnessExtensionContextsOptions): ReadonlySessionManager {
	const unsupported = (method: string): never => {
		throw new Error(`Legacy sessionManager.${method} is not available on the canonical Harness Session`);
	};
	return {
		getCwd: () => options.cwd,
		getSessionDir: () => dirname(options.getRuntime().sessionPath),
		getSessionId: () => options.getRuntime().sessionId,
		getSessionFile: () => options.getRuntime().sessionPath,
		getLeafId: () => unsupported("getLeafId"),
		getLeafEntry: () => unsupported("getLeafEntry"),
		getEntry: () => unsupported("getEntry"),
		getLabel: () => unsupported("getLabel"),
		getBranch: () => unsupported("getBranch"),
		buildContextEntries: () => unsupported("buildContextEntries"),
		getHeader: () => unsupported("getHeader"),
		getEntries: () => unsupported("getEntries"),
		getTree: () => unsupported("getTree"),
		getSessionName: () => options.getRuntime().getSessionName(),
	};
}

function unsupportedCommand(name: string): Promise<never> {
	return Promise.reject(new Error(`Legacy Extension command action ${name} is not supported by Coding Runtime yet`));
}
