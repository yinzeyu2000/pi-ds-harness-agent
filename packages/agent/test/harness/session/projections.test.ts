import { type AssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { InMemorySessionRepo, projectSession } from "../../../src/harness/session/index.ts";
import type { AgentMessage } from "../../../src/types.ts";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function assistantToolCall(): AssistantMessage {
	return {
		role: "assistant",
		content: [fauxToolCall("lookup", { query: "value" }, { id: "call-1" })],
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
		stopReason: "toolUse",
		timestamp: 2,
	};
}

describe("canonical session projections", () => {
	it("rebuilds deterministic messages, turn state, and tool state from the Pi reducer", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "projection" });
		const anchorId = await session.appendCustomEntry("request-configuration", { schemaVersion: 1 });
		await session.appendRecord({
			type: "operation_started",
			id: "run-1",
			lane: "main",
			sourceLeafId: anchorId,
			intent: { kind: "run", originalPrompt: [userMessage("question")], initialMessages: [] },
		});
		await session.appendEntry({ type: "message", id: "user-1", message: userMessage("question") }, "main");
		await session.appendRecord({
			type: "step_attempt",
			id: "assistant-attempt-1",
			lane: "main",
			runId: "run-1",
			step: "assistant",
			attempt: 1,
			resultEntryId: "assistant-1",
		});
		await session.appendEntry({ type: "message", id: "assistant-1", message: assistantToolCall() }, "main");
		await session.appendRecord({
			type: "tool_started",
			id: "tool-start-1",
			lane: "main",
			runId: "run-1",
			assistantEntryId: "assistant-1",
			toolIndex: 0,
			toolCallId: "call-1",
			toolName: "lookup",
			effectiveArgs: { query: "value" },
			resultEntryId: "tool-result-1",
			replay: "safe",
		});

		const live = await projectSession(session);
		expect(live.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(live.turnState.operation).toMatchObject({ id: "run-1", kind: "run" });
		expect(live.toolState).toMatchObject({
			assistantEntryId: "assistant-1",
			unresolved: true,
			calls: [{ toolIndex: 0, resultExists: false, started: { replay: "safe" } }],
		});

		const replayed = await projectSession(await repo.open(await session.getMetadata()));
		expect(replayed).toEqual(live);
		expect(await projectSession(session)).toEqual(live);

		await session.appendEntry(
			{
				type: "message",
				id: "tool-result-1",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "lookup",
					content: [{ type: "text", text: "value" }],
					details: {},
					isError: false,
					timestamp: 3,
				},
			},
			"main",
		);
		await session.appendRecord({
			type: "operation_finished",
			id: "finish-1",
			lane: "main",
			runId: "run-1",
			outcome: "completed",
		});

		const completed = await projectSession(session);
		expect(completed.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(completed.turnState.operation).toBeNull();
		expect(completed.toolState).toBeNull();
	});
});
