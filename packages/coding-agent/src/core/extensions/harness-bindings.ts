import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentEvent,
	AgentMessage,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
	Session,
} from "@earendil-works/pi-agent-core";
import type { DriverRunPreparation, PiAgentDriver } from "@pi-ds/harness-runtime";
import { createSyntheticSourceInfo } from "../source-info.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
import type { LegacyExtensionSetContribution } from "./harness-adapter.ts";
import type {
	BeforeAgentStartEventResult,
	Extension,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionError,
	ExtensionEvent,
	ExtensionRuntime,
	MessageEndEventResult,
	RegisteredCommand,
	ToolCallEventResult,
	ToolResultEventResult,
} from "./types.ts";

type ObservableExtensionEvent = Extract<
	ExtensionEvent,
	{
		type:
			| "agent_start"
			| "agent_end"
			| "turn_start"
			| "turn_end"
			| "message_start"
			| "message_update"
			| "tool_execution_start"
			| "tool_execution_update"
			| "tool_execution_end";
	}
>;

export interface CodingRuntimeCommand {
	name: string;
	invocationName: string;
	description?: string;
	execute(args: string): Promise<void>;
}

export interface LegacyExtensionRuntimeBinding {
	flush(): Promise<void>;
}

export function bindLegacyExtensionRuntimeActions(options: {
	contribution: LegacyExtensionSetContribution;
	driver: PiAgentDriver;
	session: Session;
	availableTools: readonly AgentTool[];
	toolReplay: Readonly<Record<string, "never" | "safe">>;
	toolPolicyVersions: Readonly<Record<string, string>>;
	initialSessionName?: string;
	errors: ExtensionError[];
}): LegacyExtensionRuntimeBinding {
	const pending = new Set<Promise<void>>();
	const availableTools = new Map(options.availableTools.map((tool) => [tool.name, tool]));
	const extensionToolNames = new Set(
		options.contribution.extensions.flatMap((extension) => [...extension.tools.keys()]),
	);
	let sessionName = options.initialSessionName;
	const schedule = (event: string, operation: Promise<unknown>) => {
		const tracked = operation
			.then(() => undefined)
			.catch((error) => {
				options.errors.push(runtimeActionError(event, error));
			})
			.finally(() => pending.delete(tracked));
		pending.add(tracked);
	};
	const dispatchMessage = (message: AgentMessage, deliverAs?: "steer" | "followUp") => {
		const operation = options.driver.isIdle()
			? options.driver.prompt(message)
			: deliverAs === "steer"
				? options.driver.steer(message)
				: options.driver.followUp(message);
		schedule("send_message", operation);
	};
	const runtime: ExtensionRuntime = options.contribution.runtime;
	runtime.sendMessage = (message, messageOptions) => {
		const custom: AgentMessage = {
			role: "custom",
			customType: message.customType,
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		};
		if (messageOptions?.triggerTurn) {
			dispatchMessage(custom, messageOptions.deliverAs === "steer" ? "steer" : "followUp");
			return;
		}
		if (options.driver.isIdle()) schedule("send_message", options.driver.appendContextMessage(custom));
		else dispatchMessage(custom, messageOptions?.deliverAs === "steer" ? "steer" : "followUp");
	};
	runtime.sendUserMessage = (content, messageOptions) => {
		dispatchMessage(
			{ role: "user", content, timestamp: Date.now() },
			messageOptions?.deliverAs === "steer" ? "steer" : "followUp",
		);
	};
	runtime.appendEntry = (customType, data) =>
		schedule("append_entry", options.session.appendCustomEntry(customType, data));
	runtime.setSessionName = (name) => {
		sessionName = name;
		schedule("set_session_name", options.session.setName(name));
	};
	runtime.getSessionName = () => sessionName;
	runtime.setLabel = (entryId, label) => schedule("set_label", options.session.setLabel(entryId, label));
	runtime.getActiveTools = () => options.driver.toolNames;
	runtime.getAllTools = () => [
		...[...availableTools.values()]
			.filter((tool) => !extensionToolNames.has(tool.name))
			.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				sourceInfo: createSyntheticSourceInfo(`<builtin:${tool.name}>`, { source: "coding-runtime" }),
			})),
		...options.contribution.extensions.flatMap((extension) =>
			[...extension.tools.values()].map(({ definition }) => ({
				name: definition.name,
				description: definition.description,
				parameters: definition.parameters,
				promptGuidelines: definition.promptGuidelines,
				sourceInfo: extension.sourceInfo,
			})),
		),
	];
	runtime.setActiveTools = (toolNames) => {
		const uniqueNames = [...new Set(toolNames)];
		const unknown = uniqueNames.filter((name) => !availableTools.has(name));
		if (unknown.length > 0) throw new Error(`Unknown active Tool(s): ${unknown.join(", ")}`);
		options.driver.setTools(
			uniqueNames.map((name) => availableTools.get(name)!),
			Object.fromEntries(uniqueNames.map((name) => [name, options.toolReplay[name] ?? "never"])),
			Object.fromEntries(
				uniqueNames.flatMap((name) =>
					options.toolPolicyVersions[name] ? [[name, options.toolPolicyVersions[name]]] : [],
				),
			),
		);
	};
	runtime.refreshTools = () => {};
	runtime.getCommands = () => {
		const commands = createLegacyExtensionCommands(options.contribution.extensions, undefined);
		const registrations = options.contribution.extensions.flatMap((extension) =>
			[...extension.commands.values()].map((command) => ({ command, sourceInfo: extension.sourceInfo })),
		);
		return commands.map((command, index) => ({
			name: command.invocationName,
			description: command.description,
			source: "extension" as const,
			sourceInfo: registrations[index]!.sourceInfo,
		}));
	};
	runtime.setModel = async (model) => {
		options.driver.setModel(model);
		return true;
	};
	runtime.getThinkingLevel = () => options.driver.thinkingLevel;
	runtime.setThinkingLevel = (level) => {
		options.driver.setThinkingLevel(level);
	};
	for (const registration of runtime.pendingProviderRegistrations) {
		options.errors.push(
			runtimeActionError(
				"register_provider",
				`Provider ${registration.name} is not supported by Coding Runtime yet`,
			),
		);
	}
	for (const registration of runtime.pendingNativeProviderRegistrations) {
		options.errors.push(
			runtimeActionError(
				"register_provider",
				`Provider ${registration.provider.id} is not supported by Coding Runtime yet`,
			),
		);
	}
	runtime.registerProvider = (name) => {
		throw new Error(`Provider ${name} cannot be registered after Coding Runtime activation`);
	};
	runtime.registerNativeProvider = (provider) => {
		throw new Error(`Provider ${provider.id} cannot be registered after Coding Runtime activation`);
	};
	runtime.unregisterProvider = (name) => {
		throw new Error(`Provider ${name} cannot be unregistered by Coding Runtime`);
	};
	return {
		async flush() {
			while (pending.size > 0) await Promise.all([...pending]);
		},
	};
}

function runtimeActionError(event: string, error: unknown): ExtensionError {
	return {
		extensionPath: "<runtime>",
		event,
		error: error instanceof Error ? error.message : String(error),
		stack: error instanceof Error ? error.stack : undefined,
	};
}

export function createLegacyExtensionCommands(
	extensions: readonly Extension[],
	contextFactory: (() => ExtensionCommandContext) | undefined,
): CodingRuntimeCommand[] {
	return resolveCommands(extensions).map(({ command, invocationName }) => ({
		name: command.name,
		invocationName,
		description: command.description,
		async execute(args) {
			if (!contextFactory) {
				throw new Error(
					`Legacy extension command /${invocationName} requires an Extension command context binding`,
				);
			}
			await command.handler(args, contextFactory());
		},
	}));
}

export function subscribeLegacyExtensionEvents(options: {
	driver: PiAgentDriver;
	extensions: readonly Extension[];
	contextFactory?: () => ExtensionContext;
	errors: ExtensionError[];
}): () => void {
	if (!options.contextFactory) return () => {};
	const contextFactory = options.contextFactory;
	let turnIndex = 0;
	return options.driver.events.on("agent/event", async (event) => {
		const extensionEvent = toObservableExtensionEvent(event, turnIndex);
		if (event.type === "agent_start") turnIndex = 0;
		if (event.type === "turn_end") turnIndex++;
		if (!extensionEvent) return;
		for (const extension of options.extensions) {
			for (const handler of extension.handlers.get(extensionEvent.type) ?? []) {
				try {
					await handler(structuredClone(extensionEvent), contextFactory());
				} catch (error) {
					options.errors.push({
						extensionPath: extension.path,
						event: extensionEvent.type,
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
					});
				}
			}
		}
	});
}

export async function prepareLegacyExtensionRun(options: {
	preparation: DriverRunPreparation;
	extensions: readonly Extension[];
	contextFactory?: () => ExtensionContext;
	errors: ExtensionError[];
	systemPromptOptions: BuildSystemPromptOptions;
}): Promise<DriverRunPreparation> {
	if (!options.contextFactory) return options.preparation;
	let systemPrompt = options.preparation.systemPrompt;
	const messages = [...options.preparation.messages];
	const prompt = promptText(messages[0]);
	for (const extension of options.extensions) {
		for (const handler of extension.handlers.get("before_agent_start") ?? []) {
			try {
				const result = (await handler(
					{
						type: "before_agent_start",
						prompt,
						systemPrompt,
						systemPromptOptions: options.systemPromptOptions,
					},
					options.contextFactory(),
				)) as BeforeAgentStartEventResult | undefined;
				if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
				if (result?.message) {
					messages.push({
						role: "custom",
						customType: result.message.customType,
						content: result.message.content ?? [],
						display: result.message.display,
						details: result.message.details,
						timestamp: Date.now(),
					});
				}
			} catch (error) {
				options.errors.push({
					extensionPath: extension.path,
					event: "before_agent_start",
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
			}
		}
	}
	return { messages, systemPrompt };
}

export async function transformLegacyExtensionMessageEnd(options: {
	message: AgentMessage;
	extensions: readonly Extension[];
	contextFactory?: () => ExtensionContext;
	errors: ExtensionError[];
}): Promise<AgentMessage> {
	if (!options.contextFactory) return options.message;
	let currentMessage = options.message;
	for (const extension of options.extensions) {
		for (const handler of extension.handlers.get("message_end") ?? []) {
			try {
				const result = (await handler(
					{ type: "message_end", message: currentMessage },
					options.contextFactory(),
				)) as MessageEndEventResult | undefined;
				if (!result?.message) continue;
				if (result.message.role !== currentMessage.role) {
					options.errors.push({
						extensionPath: extension.path,
						event: "message_end",
						error: "message_end handlers must return a message with the same role",
					});
					continue;
				}
				currentMessage = result.message;
			} catch (error) {
				options.errors.push({
					extensionPath: extension.path,
					event: "message_end",
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
			}
		}
	}
	return currentMessage;
}

export async function runLegacyExtensionBeforeTool(options: {
	toolContext: BeforeToolCallContext;
	extensions: readonly Extension[];
	contextFactory?: () => ExtensionContext;
	errors: ExtensionError[];
}): Promise<BeforeToolCallResult | undefined> {
	if (!options.contextFactory) return undefined;
	const event = {
		type: "tool_call" as const,
		toolName: options.toolContext.toolCall.name,
		toolCallId: options.toolContext.toolCall.id,
		input: options.toolContext.args as Record<string, unknown>,
	};
	for (const extension of options.extensions) {
		for (const handler of extension.handlers.get("tool_call") ?? []) {
			try {
				const result = (await handler(event, options.contextFactory())) as ToolCallEventResult | undefined;
				if (result?.block) return result;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				options.errors.push({
					extensionPath: extension.path,
					event: "tool_call",
					error: message,
					stack: error instanceof Error ? error.stack : undefined,
				});
				return { block: true, reason: `Extension failed, blocking execution: ${message}` };
			}
		}
	}
	return undefined;
}

export async function runLegacyExtensionAfterTool(options: {
	toolContext: AfterToolCallContext;
	extensions: readonly Extension[];
	contextFactory?: () => ExtensionContext;
	errors: ExtensionError[];
}): Promise<AfterToolCallResult | undefined> {
	if (!options.contextFactory) return undefined;
	const current: AfterToolCallResult = {
		content: options.toolContext.result.content,
		details: options.toolContext.result.details,
		isError: options.toolContext.isError,
		usage: options.toolContext.result.usage,
	};
	let modified = false;
	for (const extension of options.extensions) {
		for (const handler of extension.handlers.get("tool_result") ?? []) {
			try {
				const result = (await handler(
					{
						type: "tool_result",
						toolName: options.toolContext.toolCall.name,
						toolCallId: options.toolContext.toolCall.id,
						input: options.toolContext.args as Record<string, unknown>,
						content: current.content ?? [],
						details: current.details,
						isError: current.isError ?? false,
						usage: current.usage,
					},
					options.contextFactory(),
				)) as ToolResultEventResult | undefined;
				if (!result) continue;
				if (result.content !== undefined) current.content = result.content;
				if (result.details !== undefined) current.details = result.details;
				if (result.isError !== undefined) current.isError = result.isError;
				if (result.usage !== undefined) current.usage = result.usage;
				modified = true;
			} catch (error) {
				options.errors.push({
					extensionPath: extension.path,
					event: "tool_result",
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
			}
		}
	}
	return modified ? current : undefined;
}

function resolveCommands(
	extensions: readonly Extension[],
): Array<{ command: RegisteredCommand; invocationName: string }> {
	const commands = extensions.flatMap((extension) => [...extension.commands.values()]);
	const counts = new Map<string, number>();
	for (const command of commands) counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
	const seen = new Map<string, number>();
	const taken = new Set<string>();
	return commands.map((command) => {
		const occurrence = (seen.get(command.name) ?? 0) + 1;
		seen.set(command.name, occurrence);
		let suffix = occurrence;
		let invocationName = (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${suffix}` : command.name;
		while (taken.has(invocationName)) invocationName = `${command.name}:${++suffix}`;
		taken.add(invocationName);
		return { command, invocationName };
	});
}

function toObservableExtensionEvent(event: AgentEvent, turnIndex: number): ObservableExtensionEvent | undefined {
	switch (event.type) {
		case "agent_start":
			return { type: "agent_start" };
		case "agent_end":
			return { type: "agent_end", messages: event.messages };
		case "turn_start":
			return { type: "turn_start", turnIndex, timestamp: Date.now() };
		case "turn_end":
			return { type: "turn_end", turnIndex, message: event.message, toolResults: event.toolResults };
		case "message_start":
			return { type: "message_start", message: event.message };
		case "message_update":
			return {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
		case "tool_execution_start":
			return {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
		case "tool_execution_update":
			return {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
		case "tool_execution_end":
			return {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
		default:
			return undefined;
	}
}

function promptText(message: AgentMessage | undefined): string {
	if (message?.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}
