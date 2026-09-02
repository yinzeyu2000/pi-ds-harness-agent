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
		const tool: AgentTool = {
			name: "read_version",
			label: "Read version",
			description: "Returns the test version without side effects",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: "0.1.0" }], details: { version: "0.1.0" } };
			},
		};
		const repo = new InMemorySessionRepo();
		const first = await createMinimalRuntime({ streamFn, tools: [tool], sessionRepo: repo, sessionId: "demo" });
		await first.driver.prompt("Read the version");
		const original = structuredClone(first.driver.messages);
		expect(original.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const terminal = await first.session.findRecords({ type: "operation_finished" });
		expect(terminal).toHaveLength(1);
		expect(terminal[0]?.outcome).toBe("completed");
		await first.dispose();

		const second = await createMinimalRuntime({ streamFn, tools: [tool], sessionRepo: repo, sessionId: "demo" });
		expect(second.driver.messages).toEqual(original);
		expect(second.profile.id).toBe("minimal");
		await second.dispose();
	});
});
