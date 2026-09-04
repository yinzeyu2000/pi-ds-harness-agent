import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { runAgentLoop } from "../packages/agent/src/agent-loop.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	StreamFn,
} from "../packages/agent/src/types.ts";

const PI_BASELINE = "b8b873b9872db04a938fb4357b5e8e824ddc051c";

class FakeAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Fake stream ended without a terminal event");
			},
		);
	}
}

function usage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function model(): Model<"openai-responses"> {
	return {
		id: "m0-fake",
		name: "M0 Fake LLM",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
}

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "m0-fake",
		usage: usage(),
		stopReason,
		errorMessage,
		timestamp: 0,
	};
}

function user(content: string): UserMessage {
	return { role: "user", content, timestamp: 0 };
}

function identity(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message): message is Message =>
			message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

interface TraceResult {
	name: string;
	eventTypes: string[];
	messageRoles: string[];
	assistantStopReasons: string[];
	toolEndOrder: string[];
	toolResultOrder: string[];
	streamUpdates: string[];
}

async function capture(
	name: string,
	streamFn: StreamFn,
	tools: AgentContext["tools"] = [],
	signal?: AbortSignal,
	toolExecutionMode?: AgentLoopConfig["toolExecutionMode"],
): Promise<TraceResult> {
	const events: AgentEvent[] = [];
	const messages = await runAgentLoop(
		[user(`prompt:${name}`)],
		{ systemPrompt: "M0 deterministic trace", messages: [], tools },
		{ model: model(), convertToLlm: identity, toolExecutionMode },
		(event) => events.push(event),
		signal,
		streamFn,
	);

	return {
		name,
		eventTypes: events.map((event) => event.type),
		messageRoles: messages.map((message) => message.role),
		assistantStopReasons: messages.flatMap((message) =>
			message.role === "assistant" ? [message.stopReason] : [],
		),
		toolEndOrder: events.flatMap((event) =>
			event.type === "tool_execution_end" ? [event.toolCallId] : [],
		),
		toolResultOrder: messages.flatMap((message) =>
			message.role === "toolResult" ? [message.toolCallId] : [],
		),
		streamUpdates: events.flatMap((event) =>
			event.type === "message_update" ? [event.assistantMessageEvent.type] : [],
		),
	};
}

function scriptedStream(messages: AssistantMessage[]): StreamFn {
	let index = 0;
	return () => {
		const stream = new FakeAssistantStream();
		queueMicrotask(() => {
			const message = messages[index++];
			if (!message) throw new Error("Fake LLM script exhausted");
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				stream.push({ type: "error", reason: message.stopReason, error: message });
			} else if (
				message.stopReason === "stop" ||
				message.stopReason === "length" ||
				message.stopReason === "toolUse" ||
				message.stopReason === "deferred"
			) {
				stream.push({ type: "done", reason: message.stopReason, message });
			}
		});
		return stream;
	};
}

const valueSchema = Type.Object({ value: Type.String() });

function echoTool(name = "echo"): AgentTool<typeof valueSchema, { value: string }> {
	return {
		name,
		label: name,
		description: `Deterministic ${name} tool`,
		parameters: valueSchema,
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `${name}:${params.value}` }],
				details: { value: params.value },
			};
		},
	};
}

async function buildGoldenTrace() {
	const pureConversation = await capture(
		"pure-conversation",
		scriptedStream([assistant([{ type: "text", text: "hello" }])]),
	);

	const singleTool = await capture(
		"single-tool",
		scriptedStream([
			assistant([{ type: "toolCall", id: "call-echo", name: "echo", arguments: { value: "one" } }], "toolUse"),
			assistant([{ type: "text", text: "done" }]),
		]),
		[echoTool()],
	);

	let releaseSlow: (() => void) | undefined;
	const slowGate = new Promise<void>((resolve) => {
		releaseSlow = resolve;
	});
	const slow: AgentTool<typeof valueSchema, { value: string }> = {
		...echoTool("slow"),
		async execute(_toolCallId, params) {
			await slowGate;
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
			return { content: [{ type: "text", text: `slow:${params.value}` }], details: { value: params.value } };
		},
	};
	const fast: AgentTool<typeof valueSchema, { value: string }> = {
		...echoTool("fast"),
		async execute(_toolCallId, params) {
			releaseSlow?.();
			return { content: [{ type: "text", text: `fast:${params.value}` }], details: { value: params.value } };
		},
	};
	const multiTool = await capture(
		"parallel-multi-tool",
		scriptedStream([
			assistant(
				[
					{ type: "toolCall", id: "call-slow", name: "slow", arguments: { value: "first" } },
					{ type: "toolCall", id: "call-fast", name: "fast", arguments: { value: "second" } },
				],
				"toolUse",
			),
			assistant([{ type: "text", text: "both done" }]),
		]),
		[slow, fast],
		undefined,
		"parallel",
	);

	const controller = new AbortController();
	const interrupted = await capture(
		"streaming-interrupt",
		() => {
			const stream = new FakeAssistantStream();
			queueMicrotask(() => {
				const starting = assistant([], "pending");
				stream.push({ type: "start", partial: starting });
				const partial = assistant([{ type: "text", text: "partial" }], "pending");
				stream.push({ type: "text_start", contentIndex: 0, partial });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial });
				controller.abort();
				stream.push({
					type: "error",
					reason: "aborted",
					error: assistant([{ type: "text", text: "partial" }], "aborted", "Operation aborted"),
				});
			});
			return stream;
		},
		[],
		controller.signal,
	);

	return {
		schemaVersion: 1,
		piBaseline: PI_BASELINE,
		traces: [pureConversation, singleTool, multiTool, interrupted],
	};
}

const golden = await buildGoldenTrace();
const serialized = `${JSON.stringify(golden, null, 2)}\n`;

if (process.argv.includes("--check")) {
	const fixturePath = resolve(fileURLToPath(new URL("../tests/golden/m0-agent-loop.json", import.meta.url)));
	const expected: unknown = JSON.parse(await readFile(fixturePath, "utf8"));
	if (JSON.stringify(expected) !== JSON.stringify(golden)) {
		console.error("M0 golden traces differ. Run this script without --check and review the new output.");
		process.exitCode = 1;
	} else {
		console.log("M0 golden traces match (4 scenarios)");
	}
} else {
	process.stdout.write(serialized);
}
