import { dirname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PiAgentDriver } from "@pi-ds/harness-runtime";
import type { ModelRegistry } from "../model-registry.ts";
import type { ReadonlySessionManager } from "../session-manager.ts";
import { getNoOpExtensionUIContext } from "./runner.ts";
import type {
	BuildSystemPromptOptions,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionMode,
	ExtensionUIContext,
	ReplacedSessionContext,
} from "./types.ts";

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
	ui?: ExtensionUIContext;
	hasUI?: boolean;
	onShutdown?: () => void;
	sessionOperations?: {
		newSession(parentSession?: string): Promise<void>;
		fork(entryId: string, position: "before" | "at"): Promise<void>;
		switchSession(sessionPath: string): Promise<void>;
		reload(): Promise<void>;
	};
}

export function createHarnessExtensionContexts(options: CreateHarnessExtensionContextsOptions): {
	context: () => ExtensionContext;
	commandContext: () => ExtensionCommandContext;
} {
	const sessionManager = createHarnessReadonlySessionManager(options);
	const context = (): ExtensionContext => ({
		ui: options.ui ?? getNoOpExtensionUIContext(),
		mode: options.mode,
		hasUI: options.hasUI ?? false,
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
	const commandContext = (): ExtensionCommandContext => {
		const command = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(context()),
		) as ExtensionCommandContext;
		command.getSystemPromptOptions = () => options.systemPromptOptions;
		command.waitForIdle = () => options.getRuntime().driver.waitForIdle();
		command.newSession = async (sessionOptions) => {
			const operations = requireSessionOperations(options, "newSession");
			if (sessionOptions?.setup) {
				throw new Error("Legacy newSession setup(SessionManager) is not supported by Coding Runtime");
			}
			await operations.newSession(sessionOptions?.parentSession);
			await invokeWithReplacedContext(options, commandContext, sessionOptions?.withSession);
			return { cancelled: false };
		};
		command.fork = async (entryId, forkOptions) => {
			await requireSessionOperations(options, "fork").fork(entryId, forkOptions?.position ?? "before");
			await invokeWithReplacedContext(options, commandContext, forkOptions?.withSession);
			return { cancelled: false };
		};
		command.navigateTree = async (targetId, navigationOptions) => {
			if (navigationOptions?.replaceInstructions) {
				throw new Error("Legacy navigateTree replaceInstructions is not supported by Coding Runtime");
			}
			await options.getRuntime().driver.navigateTree(targetId, navigationOptions);
			return { cancelled: false };
		};
		command.switchSession = async (sessionPath, switchOptions) => {
			await requireSessionOperations(options, "switchSession").switchSession(sessionPath);
			await invokeWithReplacedContext(options, commandContext, switchOptions?.withSession);
			return { cancelled: false };
		};
		command.reload = () => requireSessionOperations(options, "reload").reload();
		return command;
	};
	return {
		context,
		commandContext,
	};
}

function requireSessionOperations(
	options: CreateHarnessExtensionContextsOptions,
	name: string,
): NonNullable<CreateHarnessExtensionContextsOptions["sessionOperations"]> {
	if (!options.sessionOperations) {
		throw new Error(`Legacy Extension command action ${name} requires a Coding Runtime Host`);
	}
	return options.sessionOperations;
}

async function invokeWithReplacedContext(
	options: CreateHarnessExtensionContextsOptions,
	commandContext: () => ExtensionCommandContext,
	callback: ((ctx: ReplacedSessionContext) => Promise<void>) | undefined,
): Promise<void> {
	if (!callback) return;
	const context = Object.defineProperties(
		{},
		Object.getOwnPropertyDescriptors(commandContext()),
	) as ReplacedSessionContext;
	context.sendMessage = async (message, messageOptions) => {
		const custom: AgentMessage = {
			role: "custom",
			customType: message.customType,
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		};
		if (!messageOptions?.triggerTurn && options.getRuntime().driver.isIdle()) {
			await options.getRuntime().driver.appendContextMessage(custom);
			return;
		}
		await dispatchReplacedMessage(options, custom, messageOptions?.deliverAs);
	};
	context.sendUserMessage = (content, messageOptions) =>
		dispatchReplacedMessage(options, { role: "user", content, timestamp: Date.now() }, messageOptions?.deliverAs);
	await callback(context);
}

function dispatchReplacedMessage(
	options: CreateHarnessExtensionContextsOptions,
	message: AgentMessage,
	deliverAs?: "steer" | "followUp" | "nextTurn",
): Promise<void> {
	const driver = options.getRuntime().driver;
	if (driver.isIdle()) return driver.prompt(message);
	return deliverAs === "steer" ? driver.steer(message) : driver.followUp(message);
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
