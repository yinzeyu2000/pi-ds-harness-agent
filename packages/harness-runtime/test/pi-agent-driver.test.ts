import { type AgentMessage, InMemorySessionRepo, type StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createMinimalRuntime } from "../src/minimal-runtime.ts";

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

		runtime.driver.steer("discarded steer");
		runtime.driver.followUp("discarded follow up");
		runtime.driver.abort();
		expect(() => runtime.driver.followUp("too late")).toThrow("agent driver is aborting");
		runtime.driver.abort();
		await prompt;

		const aborts = await runtime.session.findRecords({ type: "abort_requested" });
		const terminals = await runtime.session.findRecords({ type: "operation_finished" });
		expect(aborts).toHaveLength(1);
		expect(terminals).toHaveLength(1);
		expect(terminals[0]?.outcome).toBe("aborted");
		expect(runtime.driver.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(runtime.driver.messages.some((message) => messageText(message).startsWith("discarded"))).toBe(false);
		expect(() => runtime.driver.steer("too late")).toThrow("agent driver is idle");
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

		runtime.driver.followUp("follow up");
		runtime.driver.steer("steer");
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
		await runtime.dispose();
	});
});
