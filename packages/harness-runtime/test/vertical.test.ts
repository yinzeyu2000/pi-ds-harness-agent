import { type AgentTool, InMemorySessionRepo, type StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createMinimalRuntime } from "../src/minimal-runtime.ts";

describe("minimal vertical runtime", () => {
	it("runs a Pi tool call and rebuilds the same model history from Memory Session", async () => {
		const assistantMessage = (
			content: AssistantMessage["content"],
			stopReason: "stop" | "toolUse",
		): AssistantMessage => ({
			role: "assistant",
			content,
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: Date.now(),
		});
		let calls = 0;
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message =
					calls++ === 0
						? assistantMessage([fauxToolCall("read_version", {})], "toolUse")
						: assistantMessage([{ type: "text", text: "version 0.1.0" }], "stop");
				stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
			});
			return stream;
		};
		let runtimeRef: Awaited<ReturnType<typeof createMinimalRuntime>>;
		let toolStartVisibleBeforeBody = false;
		const tool: AgentTool = {
			name: "read_version",
			label: "Read version",
			description: "Returns the test version without side effects",
			parameters: Type.Object({}),
			async execute() {
				toolStartVisibleBeforeBody = (await runtimeRef.session.findRecords({ type: "tool_started" })).length === 1;
				return {
					content: [{ type: "text", text: "0.1.0" }],
					details: { version: "0.1.0" },
					usage: {
						input: 1,
						output: 2,
						cacheRead: 3,
						cacheWrite: 4,
						totalTokens: 10,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
			},
		};
		const repo = new InMemorySessionRepo();
		const toolPolicies = {
			read_version: {
				version: "readonly-v1",
				pipeline: { guards: [() => ({ decision: "allow" as const })] },
			},
		};
		const first = await createMinimalRuntime({
			streamFn,
			tools: [tool],
			toolPolicies,
			sessionRepo: repo,
			sessionId: "demo",
		});
		runtimeRef = first;
		await first.driver.prompt("Read the version");
		expect(toolStartVisibleBeforeBody).toBe(true);
		const original = structuredClone(first.driver.messages);
		expect(original.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const terminal = await first.session.findRecords({ type: "operation_finished" });
		expect(terminal).toHaveLength(1);
		expect(terminal[0]?.outcome).toBe("completed");
		const [toolStarted] = await first.session.findRecords({ type: "tool_started" });
		expect(toolStarted).toMatchObject({
			toolCallId: expect.any(String),
			toolName: "read_version",
			effectiveArgs: {},
			replay: "never",
		});
		const toolResult = (await first.session.findEntries({ type: "message" })).find(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		expect(toolResult?.id).toBe(toolStarted?.resultEntryId);
		const usage = await first.session.findRecords({ type: "usage", order: "oldestFirst" });
		expect(usage.map((record) => record.cause)).toEqual(["assistant", "tool", "assistant"]);
		expect(usage[1]).toMatchObject({ cause: "tool", entryId: toolResult?.id, toolCallId: toolStarted?.toolCallId });
		const [configuration] = await first.session.findEntries({ type: "custom" });
		expect(configuration).toMatchObject({
			type: "custom",
			data: { tools: [{ name: "read_version", policyVersion: "readonly-v1" }] },
		});
		await first.dispose();

		const second = await createMinimalRuntime({
			streamFn,
			tools: [tool],
			toolPolicies,
			sessionRepo: repo,
			sessionId: "demo",
		});
		expect(second.driver.messages).toEqual(original);
		expect(second.profile.id).toBe("minimal");
		await second.dispose();
	});

	it("commits parallel tool results in assistant call order even when completion order differs", async () => {
		const assistantMessage = (
			content: AssistantMessage["content"],
			stopReason: "stop" | "toolUse",
		): AssistantMessage => ({
			role: "assistant",
			content,
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: Date.now(),
		});
		let requests = 0;
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message =
					requests++ === 0
						? assistantMessage([fauxToolCall("slow", {}), fauxToolCall("fast", {})], "toolUse")
						: assistantMessage([{ type: "text", text: "complete" }], "stop");
				stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
			});
			return stream;
		};
		let releaseSlow: (() => void) | undefined;
		const slowGate = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		const completionOrder: string[] = [];
		const tools: AgentTool[] = [
			{
				name: "slow",
				label: "Slow",
				description: "Completes second",
				parameters: Type.Object({}),
				async execute() {
					await slowGate;
					completionOrder.push("slow");
					return { content: [{ type: "text", text: "slow" }], details: {} };
				},
			},
			{
				name: "fast",
				label: "Fast",
				description: "Completes first",
				parameters: Type.Object({}),
				async execute() {
					completionOrder.push("fast");
					releaseSlow?.();
					return { content: [{ type: "text", text: "fast" }], details: {} };
				},
			},
		];
		const runtime = await createMinimalRuntime({ streamFn, tools });
		await runtime.driver.prompt("run both");
		expect(completionOrder).toEqual(["fast", "slow"]);
		const durableMessages = await runtime.session.findEntries({ type: "message", order: "oldestFirst" });
		const toolResults = durableMessages.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolName] : [],
		);
		expect(toolResults).toEqual(["slow", "fast"]);
		await runtime.dispose();
	});
});
