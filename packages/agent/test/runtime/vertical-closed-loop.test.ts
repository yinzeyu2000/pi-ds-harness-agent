import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	asClientRequestId,
	asControllerEpoch,
	asRuntimeGeneration,
	asThreadId,
	type WireEventEnvelope,
} from "@earendil-works/pi-protocol";
import Type from "typebox";
import { describe, expect, test } from "vitest";
import {
	FakeModelGateway,
	type FrozenModelRequest,
	MemoryExecutionBroker,
	MemoryJournalWriter,
	PiAgentDriver,
	ThreadRuntimeImpl,
} from "../../src/runtime/index.ts";
import type { AgentTool } from "../../src/types.ts";

describe("M2 Minimal Vertical Closed Loop", () => {
	test("Prompt -> Turn Admitted -> Fake Model -> In-Memory Tool -> Second Model -> Final Message -> Terminal Completed", async () => {
		const threadId = asThreadId("th_vert_loop");
		const writer = new MemoryJournalWriter(threadId);
		const broker = new MemoryExecutionBroker();

		// In-memory fake tool: calculate
		broker.registerTool("calculate", (input: any) => {
			const { a, b } = input;
			return { sum: a + b };
		});

		const calcTool: AgentTool = {
			name: "calculate",
			label: "Calculate",
			description: "Adds two numbers",
			parameters: Type.Object({
				a: Type.Number(),
				b: Type.Number(),
			}),
			execute: async () => {
				throw new Error("Should be intercepted by broker");
			},
		};

		const emptyUsage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		// Step counter for multi-step FakeModelGateway
		let stepCount = 0;
		const fakeGateway = new FakeModelGateway((_request: FrozenModelRequest) => {
			stepCount++;
			if (stepCount === 1) {
				// First model call: emit a tool call
				return {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_calc_001",
							name: "calculate",
							arguments: { a: 10, b: 20 },
						},
					],
					api: "openai-responses",
					provider: "openai",
					model: "fake-calc-model",
					usage: emptyUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				} as AssistantMessage;
			}
			// Second model call: return final text answer
			return {
				role: "assistant",
				content: [{ type: "text", text: "Calculation complete: sum is 30." }],
				api: "openai-responses",
				provider: "openai",
				model: "fake-calc-model",
				usage: emptyUsage,
				stopReason: "stop",
				timestamp: Date.now(),
			} as AssistantMessage;
		});

		const fakeModel = {
			id: "fake-calc-model",
			name: "Fake Calc Model",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		} as unknown as Model<any>;

		const observer1Events: WireEventEnvelope[] = [];
		const observer2Events: WireEventEnvelope[] = [];

		const driver = new PiAgentDriver({
			modelGateway: fakeGateway,
			executionBroker: broker,
			journalWriter: writer,
			model: fakeModel,
			tools: [calcTool],
			onWireEvent: (ev) => {
				runtime.broadcastWireEvent(ev);
			},
		});

		const runtime = new ThreadRuntimeImpl(threadId, asRuntimeGeneration(1), writer, driver);
		await runtime.acquireController("ctrl-loop");

		const sub1 = runtime.subscribe((ev) => observer1Events.push(ev));
		const sub2 = runtime.subscribe((ev) => observer2Events.push(ev));

		const clientReqId = asClientRequestId("req_loop_1");
		const turn = await runtime.startTurn("Please compute 10 + 20", clientReqId, asControllerEpoch(1), "user-loop");

		expect(turn.phase).toBe("admitted");
		expect(turn.clientRequestId).toBe("req_loop_1");

		// Wait for the full loop to complete
		let retries = 0;
		while (runtime.activeTurn !== undefined && retries++ < 100) {
			await new Promise((r) => setTimeout(r, 20));
		}

		expect(runtime.activeTurn).toBeUndefined();
		expect(stepCount).toBe(2);

		// Two observers received consistent, identical state
		expect(observer1Events.length).toBeGreaterThanOrEqual(4);
		expect(observer1Events.length).toBe(observer2Events.length);
		expect(observer1Events.map((e) => e.type)).toEqual(observer2Events.map((e) => e.type));

		// Journal contains full auditable record: admitted, step.started, message, step.completed, terminal
		const facts = writer.committedEnvelopes
			.filter((e) => e.record.recordType === "runtime_fact")
			.map((e) => (e.record as any).fact);

		const terminalFact = facts.find((f: any) => f.factType === "turn" && f.terminal);
		expect(terminalFact).toBeDefined();
		expect(terminalFact.status).toBe("completed");

		// Entries contain the committed assistant messages
		const messageEntries = writer.committedEnvelopes
			.filter((e) => e.record.recordType === "entry" && (e.record as any).entry.type === "message")
			.map((e) => (e.record as any).entry.message);

		expect(messageEntries.length).toBeGreaterThanOrEqual(1);
		const lastMessage = messageEntries[messageEntries.length - 1];
		expect(lastMessage.role).toBe("assistant");
		expect(lastMessage.content[0].text).toContain("Calculation complete: sum is 30.");

		sub1.dispose();
		sub2.dispose();
	});
});
