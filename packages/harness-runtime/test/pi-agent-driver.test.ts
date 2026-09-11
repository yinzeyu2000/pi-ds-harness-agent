import { type AgentMessage, InMemorySessionRepo, type StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createMinimalRuntime } from "../src/minimal-runtime.ts";
import { REQUEST_CONFIGURATION_CUSTOM_TYPE } from "../src/pi-agent-driver.ts";

interface Deferred {
	promise: Promise<void>;
	resolve(): void;
}

function createDeferred(): Deferred {
	let resolve = () => {};
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function assistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
	};
}

function messageText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

describe("PiAgentDriver control contract", () => {
	it("appends idle context through the canonical session before publishing it", async () => {
		const runtime = await createMinimalRuntime({
			streamFn: () => {
				throw new Error("context append must not invoke the model");
			},
		});
		const message: AgentMessage = {
			role: "custom",
			customType: "extension-context",
			content: "durable context",
			display: true,
			timestamp: 1,
		};

		const entryId = await runtime.driver.appendContextMessage(message);

		expect(runtime.driver.isIdle()).toBe(true);
		expect(runtime.driver.hasPendingMessages()).toBe(false);
		expect(runtime.driver.messages).toEqual([message]);
		expect(await runtime.session.getEntry(entryId)).toMatchObject({ type: "message", id: entryId, message });
		await runtime.dispose();
	});

	it("captures prepared run inputs and system prompt before operation start", async () => {
		const observedPrompts: string[] = [];
		const streamFn: StreamFn = (_model, context) => {
			observedPrompts.push(context.systemPrompt ?? "");
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistantMessage("prepared") }));
			return stream;
		};
		const runtime = await createMinimalRuntime({
			streamFn,
			systemPrompt: "base",
			runPreparationMiddleware: {
				prepare: (preparation) => ({
					systemPrompt: `${preparation.systemPrompt} extended`,
					messages: [
						...preparation.messages,
						{ role: "custom", customType: "test", content: "injected", display: true, timestamp: Date.now() },
					],
				}),
			},
		});

		await runtime.driver.prompt("hello");

		const [operation] = await runtime.session.findRecords({ type: "operation_started" });
		if (operation?.intent.kind !== "run") throw new Error("Expected run operation");
		expect(operation.intent.originalPrompt).toEqual([expect.objectContaining({ role: "user", content: "hello" })]);
		expect(operation.intent.initialMessages).toHaveLength(2);
		expect(operation.intent.systemPromptOverride).toBe("base extended");
		expect(observedPrompts).toEqual(["base extended"]);
		const persisted = await runtime.session.findEntries({ type: "message", order: "oldestFirst" });
		expect(persisted.slice(0, 2).map((entry) => entry.id)).toEqual(
			operation.intent.initialMessages.map((entry) => entry.id),
		);
		await runtime.dispose();
	});

	it("replays the durable prepared input set after an operation-start crash", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "prepared-recovery" });
		const user: AgentMessage = { role: "user", content: "original", timestamp: 1 };
		const injected: AgentMessage = {
			role: "custom",
			customType: "recovery",
			content: "durable injection",
			display: true,
			timestamp: 2,
		};
		await session.appendRecord({
			type: "operation_started",
			id: "run-prepared",
			lane: "main",
			sourceLeafId: null,
			intent: {
				kind: "run",
				originalPrompt: [user],
				initialMessages: [
					{ type: "message", id: "prepared-user", message: user },
					{ type: "message", id: "prepared-injection", message: injected },
				],
				systemPromptOverride: "durable prepared prompt",
			},
		});
		const observed: AgentMessage[][] = [];
		const streamFn: StreamFn = (_model, context) => {
			observed.push(structuredClone(context.messages));
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistantMessage("resumed") }));
			return stream;
		};
		const runtime = await createMinimalRuntime({ session, streamFn, systemPrompt: "base" });

		await runtime.driver.resume();

		expect(observed[0]).toEqual([user]);
		expect(runtime.driver.messages.slice(0, 2)).toEqual([user, injected]);
		const persisted = await session.findEntries({ type: "message", order: "oldestFirst" });
		expect(persisted.slice(0, 2).map((entry) => entry.id)).toEqual(["prepared-user", "prepared-injection"]);
		expect(await runtime.driver.getRecoveryState()).toEqual({ status: "idle" });
		await runtime.dispose();
	});

	it("restores only missing prepared inputs after a partial initial-message commit", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "partial-prepared-recovery" });
		const user: AgentMessage = { role: "user", content: "already durable", timestamp: 1 };
		const injected: AgentMessage = {
			role: "custom",
			customType: "recovery",
			content: "missing durable injection",
			display: true,
			timestamp: 2,
		};
		await session.appendRecord({
			type: "operation_started",
			id: "run-partial-prepared",
			lane: "main",
			sourceLeafId: null,
			intent: {
				kind: "run",
				originalPrompt: [user],
				initialMessages: [
					{ type: "message", id: "partial-user", message: user },
					{ type: "message", id: "partial-injection", message: injected },
				],
				systemPromptOverride: "partial prepared prompt",
			},
		});
		await session.appendEntry({ type: "message", id: "partial-user", message: user }, "main");
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistantMessage("resumed") }));
			return stream;
		};
		const runtime = await createMinimalRuntime({ session, streamFn, systemPrompt: "base" });

		expect(await runtime.driver.getRecoveryState()).toEqual({
			status: "resumable",
			runId: "run-partial-prepared",
			point: "initial_messages",
		});
		await runtime.driver.resume();

		const persisted = await session.findEntries({ type: "message", order: "oldestFirst" });
		expect(persisted.map((entry) => entry.id)).toEqual(["partial-user", "partial-injection", expect.any(String)]);
		expect(runtime.driver.messages.slice(0, 2)).toEqual([user, injected]);
		expect(await runtime.driver.getRecoveryState()).toEqual({ status: "idle" });
		await runtime.dispose();
	});

	it("applies message middleware before state and durable commit", async () => {
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: assistantMessage("original") });
			});
			return stream;
		};
		const runtime = await createMinimalRuntime({
			streamFn,
			messageCommitMiddleware: {
				transform: (message) =>
					message.role === "assistant"
						? { ...message, content: [{ type: "text", text: "transformed" }] }
						: message,
			},
		});
		const committed: AgentMessage[] = [];
		const unsubscribe = runtime.driver.events.on("message/committed", ({ message }) => {
			committed.push(message);
		});

		await runtime.driver.prompt("hello");

		const persisted = await runtime.session.findEntries({ type: "message", order: "oldestFirst" });
		expect(JSON.stringify(runtime.driver.messages.at(-1))).toContain("transformed");
		expect(JSON.stringify(persisted.at(-1))).toContain("transformed");
		expect(JSON.stringify(committed.at(-1))).toContain("transformed");
		unsubscribe();
		await runtime.dispose();
	});

	it("falls back to the original message when commit middleware fails", async () => {
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: assistantMessage("preserved") });
			});
			return stream;
		};
		const runtime = await createMinimalRuntime({
			streamFn,
			messageCommitMiddleware: {
				transform: (message) => {
					if (message.role === "assistant") throw new Error("transform failed");
					return message;
				},
			},
		});
		const failures: unknown[] = [];
		const unsubscribe = runtime.driver.events.on("message/transform-failed", (failure) => {
			failures.push(failure);
		});

		await runtime.driver.prompt("hello");

		expect(JSON.stringify(runtime.driver.messages.at(-1))).toContain("preserved");
		expect(failures).toEqual([
			expect.objectContaining({ error: expect.objectContaining({ message: "transform failed" }) }),
		]);
		unsubscribe();
		await runtime.dispose();
	});

	it("persists a versioned request configuration before invoking the model", async () => {
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: assistantMessage("anchored") });
			});
			return stream;
		};
		const runtime = await createMinimalRuntime({
			streamFn,
			systemPrompt: "stable system prompt",
			tools: [
				{
					name: "lookup",
					label: "Lookup",
					description: "Look up one value",
					parameters: Type.Object({ query: Type.String() }),
					execute: async () => ({ content: [{ type: "text", text: "value" }], details: {} }),
				},
			],
		});

		await runtime.driver.prompt("hello");

		const [configuration] = await runtime.session.findEntries({
			type: "custom",
			customType: REQUEST_CONFIGURATION_CUSTOM_TYPE,
		});
		expect(configuration).toMatchObject({
			type: "custom",
			customType: REQUEST_CONFIGURATION_CUSTOM_TYPE,
			data: {
				schemaVersion: 1,
				systemPrompt: "stable system prompt",
				model: { provider: "unknown", id: "unknown" },
				thinkingLevel: "off",
				tools: [
					{
						name: "lookup",
						description: "Look up one value",
						replay: "never",
						parameters: {
							type: "object",
							properties: { query: { type: "string" } },
							required: ["query"],
						},
					},
				],
			},
		});
		const [operation] = await runtime.session.findRecords({ type: "operation_started" });
		expect(operation?.sourceLeafId).toBe(configuration?.id);
		if (operation?.intent.kind !== "run") throw new Error("Expected run operation");
		expect(operation.intent.systemPromptOverride).toBe("stable system prompt");
		await runtime.dispose();
	});

	it("commits one aborted terminal outcome and clears queued work", async () => {
		const streamStarted = createDeferred();
		const streamFn: StreamFn = (_model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: assistantMessage("", "stop") });
				streamStarted.resolve();
				const finishAbort = () => {
					stream.push({ type: "error", reason: "aborted", error: assistantMessage("", "aborted") });
				};
				if (options?.signal?.aborted) finishAbort();
				else options?.signal?.addEventListener("abort", finishAbort, { once: true });
			});
			return stream;
		};
		const runtime = await createMinimalRuntime({ streamFn });
		const prompt = runtime.driver.prompt("wait");
		await streamStarted.promise;

		await runtime.driver.steer("discarded steer");
		await runtime.driver.followUp("discarded follow up");
		runtime.driver.abort();
		await expect(runtime.driver.followUp("too late")).rejects.toThrow("agent driver is aborting");
		runtime.driver.abort();
		await prompt;

		const aborts = await runtime.session.findRecords({ type: "abort_requested" });
		const terminals = await runtime.session.findRecords({ type: "operation_finished" });
		const enqueued = await runtime.session.findRecords({ type: "queue_enqueued", order: "oldestFirst" });
		const cancelled = await runtime.session.findRecords({ type: "queue_cancelled", order: "oldestFirst" });
		expect(aborts).toHaveLength(1);
		expect(enqueued.map((record) => record.queue)).toEqual(["steer", "followUp"]);
		expect(cancelled.map((record) => record.entryId).sort()).toEqual(
			enqueued.map((record) => record.target.id).sort(),
		);
		expect(terminals).toHaveLength(1);
		expect(terminals[0]?.outcome).toBe("aborted");
		expect(runtime.driver.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(runtime.driver.messages.some((message) => messageText(message).startsWith("discarded"))).toBe(false);
		await expect(runtime.driver.steer("too late")).rejects.toThrow("agent driver is idle");
		await runtime.dispose();
	});

	it("processes steering before follow-up and persists both in one operation", async () => {
		const firstStreamStarted = createDeferred();
		const releaseFirstResponse = createDeferred();
		const requestMessages: AgentMessage[][] = [];
		let requestCount = 0;
		const streamFn: StreamFn = (_model, context) => {
			requestMessages.push(structuredClone(context.messages));
			const currentRequest = ++requestCount;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				void (async () => {
					if (currentRequest === 1) {
						firstStreamStarted.resolve();
						await releaseFirstResponse.promise;
					}
					stream.push({ type: "done", reason: "stop", message: assistantMessage(`response ${currentRequest}`) });
				})();
			});
			return stream;
		};
		const repo = new InMemorySessionRepo();
		const runtime = await createMinimalRuntime({ streamFn, sessionRepo: repo, sessionId: "driver-queues" });
		const prompt = runtime.driver.prompt("initial");
		await firstStreamStarted.promise;

		await runtime.driver.followUp("follow up");
		await runtime.driver.steer("steer");
		releaseFirstResponse.resolve();
		await prompt;

		expect(requestCount).toBe(3);
		expect(
			requestMessages.map((messages) => messages.at(-1)).map((message) => message && messageText(message)),
		).toEqual(["initial", "steer", "follow up"]);
		expect(runtime.driver.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		const persisted = await runtime.session.findEntries({ type: "message", order: "oldestFirst" });
		expect(persisted.map((entry) => entry.type === "message" && messageText(entry.message))).toEqual([
			"initial",
			"",
			"steer",
			"",
			"follow up",
			"",
		]);
		const terminals = await runtime.session.findRecords({ type: "operation_finished" });
		expect(terminals).toHaveLength(1);
		expect(terminals[0]?.outcome).toBe("completed");
		const enqueued = await runtime.session.findRecords({ type: "queue_enqueued", order: "oldestFirst" });
		expect(enqueued.map((record) => record.queue)).toEqual(["followUp", "steer"]);
		for (const record of enqueued) {
			const entry = await runtime.session.getEntry(record.target.id);
			expect(entry).toMatchObject({ type: "message", id: record.target.id });
		}
		const usage = await runtime.session.findRecords({ type: "usage", order: "oldestFirst" });
		expect(usage).toHaveLength(3);
		expect(
			usage.map((record) => record.cause === "assistant" && { attempt: record.attempt, entryId: record.entryId }),
		).toEqual([
			{ attempt: 1, entryId: persisted[1]?.id },
			{ attempt: 2, entryId: persisted[3]?.id },
			{ attempt: 3, entryId: persisted[5]?.id },
		]);
		await runtime.dispose();
	});
});
