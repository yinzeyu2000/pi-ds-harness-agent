import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompactionPreparation, StreamFn } from "@earendil-works/pi-agent-core";
import { type Api, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createCodingRuntime } from "../src/core/coding-runtime.ts";
import { type HarnessRpcEvent, HarnessRpcSession } from "../src/modes/rpc/harness-rpc.ts";
import { HarnessRpcApprovalService } from "../src/modes/rpc/harness-rpc-approval.ts";
import { HarnessRpcExtensionUIService } from "../src/modes/rpc/harness-rpc-extension-ui.ts";

const idleStreamFn: StreamFn = () => {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() =>
		stream.push({
			type: "done",
			reason: "stop",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "idle" }],
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
				stopReason: "stop",
				timestamp: Date.now(),
			},
		}),
	);
	return stream;
};

function reasoningModel(): Model<Api> {
	return {
		id: "faux-1",
		name: "Faux Reasoning",
		api: "openai-completions",
		provider: "faux",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	};
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

describe("Harness RPC control protocol", () => {
	it("durably clears queued steering and follow-up messages", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-harness-rpc-clear-queue-"));
		const streamStarted = createDeferred();
		const releaseResponse = createDeferred();
		let requestCount = 0;
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			const currentRequest = ++requestCount;
			queueMicrotask(() => {
				void (async () => {
					if (currentRequest === 1) {
						streamStarted.resolve();
						await releaseResponse.promise;
					}
					stream.push({
						type: "done",
						reason: "stop",
						message: {
							role: "assistant",
							content: [{ type: "text", text: `response ${currentRequest}` }],
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
							stopReason: "stop",
							timestamp: Date.now(),
						},
					});
				})();
			});
			return stream;
		};
		const runtime = await createCodingRuntime({
			cwd,
			sessionsRoot: join(cwd, ".sessions"),
			sessionId: "clear-queue",
			streamFn,
			model: reasoningModel(),
			toolNames: [],
			includeDefaultSkills: false,
			compaction: {
				settings: { enabled: false, reserveTokens: 100, keepRecentTokens: 0 },
				execute: async () => {
					throw new Error("not used");
				},
			},
		});
		const rpc = await HarnessRpcSession.create(runtime, () => undefined);
		try {
			expect(await rpc.handle({ type: "prompt", message: "initial" })).toMatchObject({ success: true });
			await streamStarted.promise;
			expect(await rpc.handle({ type: "follow_up", message: "cancel follow up" })).toMatchObject({ success: true });
			expect(await rpc.handle({ type: "steer", message: "cancel steer" })).toMatchObject({ success: true });
			expect(await rpc.handle({ id: "clear", type: "clear_queue" })).toEqual({
				type: "response",
				id: "clear",
				command: "clear_queue",
				success: true,
				data: { steering: ["cancel steer"], followUp: ["cancel follow up"] },
			});
			releaseResponse.resolve();
			await rpc.waitForIdle();
			expect(requestCount).toBe(1);
			const enqueued = await runtime.session.findRecords({ type: "queue_enqueued" });
			const cancelled = await runtime.session.findRecords({ type: "queue_cancelled" });
			expect(cancelled.map((record) => record.entryId).sort()).toEqual(
				enqueued.map((record) => record.target.id).sort(),
			);
		} finally {
			releaseResponse.resolve();
			await rpc.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("dispatches commands and emits durable snapshots without a second session state", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-harness-rpc-"));
		const events: HarnessRpcEvent[] = [];
		const changedModels: string[] = [];
		const changedThinkingLevels: string[] = [];
		const changedToolSets: string[][] = [];
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "rpc response" }],
						api: "faux",
						provider: "faux",
						model: "faux-1",
						usage: {
							input: 10,
							output: 2,
							cacheRead: 3,
							cacheWrite: 1,
							totalTokens: 16,
							cost: { input: 0.1, output: 0.02, cacheRead: 0.03, cacheWrite: 0.01, total: 0.16 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
				}),
			);
			return stream;
		};
		const runtime = await createCodingRuntime({
			cwd,
			sessionsRoot: join(cwd, ".sessions"),
			sessionId: "rpc",
			streamFn,
			model: reasoningModel(),
			toolNames: [],
			includeDefaultSkills: false,
			compaction: {
				settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 0 },
				execute: async (preparation: CompactionPreparation) => ({
					summary: "summary",
					tokensBefore: preparation.tokensBefore,
					retainedTail: preparation.retainedTail,
				}),
			},
		});
		const rpc = await HarnessRpcSession.create(
			runtime,
			(event) => {
				events.push(event);
			},
			{
				resolveModel: (provider, model) => ({
					...runtime.driver.model,
					provider,
					id: model,
					name: "Alternate model",
				}),
				listModels: () => [
					{
						...runtime.driver.model,
						provider: "faux",
						id: "faux-2",
						name: "Alternate model",
					},
					{
						...runtime.driver.model,
						provider: "faux",
						id: "faux-3",
						name: "Third model",
					},
				],
				modelsScoped: true,
				onModelChanged: (model) => {
					changedModels.push(model.id);
				},
				onThinkingLevelChanged: (level) => {
					changedThinkingLevels.push(level);
				},
				onToolsChanged: (names) => {
					changedToolSets.push([...names]);
				},
			},
		);

		const firstPrompt = await rpc.handle({ id: "p1", type: "prompt", message: "hello" });
		expect(firstPrompt).toMatchObject({
			id: "p1",
			command: "prompt",
			success: true,
		});
		expect(await rpc.handle({ id: "p2", type: "prompt", message: "too soon" })).toMatchObject({
			id: "p2",
			command: "prompt",
			success: false,
			error: "Runtime is already processing a prompt",
		});
		await rpc.waitForIdle();
		const messages = await rpc.handle({ id: "m1", type: "get_messages" });
		expect(JSON.stringify(messages)).toContain("rpc response");
		expect(await rpc.handle({ type: "get_last_assistant_text" })).toMatchObject({
			success: true,
			data: { text: "rpc response" },
		});
		expect(await rpc.handle({ type: "get_session_stats" })).toMatchObject({
			success: true,
			data: {
				sessionId: "rpc",
				userMessages: 1,
				assistantMessages: 1,
				toolCalls: 0,
				toolResults: 0,
				totalMessages: 2,
				tokens: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, total: 16 },
				cost: 0.16,
				contextUsage: { tokens: 16 },
			},
		});
		const entries = await rpc.handle({ type: "get_entries" });
		expect(entries).toMatchObject({
			success: true,
			data: { entries: expect.any(Array), leafId: expect.any(String) },
		});
		if (!entries.success || !entries.data || typeof entries.data !== "object" || !("entries" in entries.data)) {
			throw new Error("Expected get_entries data");
		}
		const entryList = entries.data.entries;
		if (!Array.isArray(entryList)) throw new Error("Expected get_entries entry array");
		const userEntry = entryList.find(
			(entry): entry is { id: string; message: { role: string } } =>
				typeof entry === "object" &&
				entry !== null &&
				"id" in entry &&
				typeof entry.id === "string" &&
				"message" in entry &&
				typeof entry.message === "object" &&
				entry.message !== null &&
				"role" in entry.message &&
				entry.message.role === "user",
		);
		if (!userEntry) throw new Error("Expected user entry");
		await runtime.session.setLabel(userEntry.id, "Start");
		const exported = await rpc.handle({ type: "export_html", outputPath: "exports/rpc.html" });
		expect(exported).toEqual({
			type: "response",
			command: "export_html",
			success: true,
			data: { path: join(cwd, "exports", "rpc.html") },
		});
		const exportHtml = await readFile(join(cwd, "exports", "rpc.html"), "utf8");
		const encodedSessionData = /<script id="session-data" type="application\/json">([^<]+)<\/script>/u.exec(
			exportHtml,
		)?.[1];
		if (!encodedSessionData) throw new Error("Expected embedded session data");
		const exportedSession = JSON.parse(Buffer.from(encodedSessionData, "base64").toString("utf8")) as unknown;
		expect(exportedSession).toMatchObject({
			header: { version: 4, id: "rpc", cwd },
			leafId: expect.any(String),
			systemPrompt: expect.any(String),
			entries: expect.arrayContaining([
				expect.objectContaining({ id: userEntry.id, type: "message" }),
				expect.objectContaining({ type: "label", targetId: userEntry.id, label: "Start" }),
			]),
		});
		expect(await rpc.handle({ type: "get_entries", since: userEntry.id })).toMatchObject({
			success: true,
			data: {
				entries: expect.arrayContaining([
					expect.objectContaining({ type: "message", message: expect.objectContaining({ role: "assistant" }) }),
				]),
			},
		});
		expect(await rpc.handle({ type: "get_entries", since: "missing" })).toMatchObject({
			success: false,
			error: "Entry not found: missing",
		});
		expect(await rpc.handle({ type: "get_fork_messages" })).toMatchObject({
			success: true,
			data: { messages: [expect.objectContaining({ text: "hello" })] },
		});
		expect(await rpc.handle({ type: "set_session_name", name: "RPC session" })).toMatchObject({ success: true });
		const snapshot = await rpc.handle({ type: "get_snapshot" });
		expect(snapshot).toMatchObject({
			success: true,
			data: { session: { id: "rpc", name: "RPC session" }, recovery: { status: "idle" } },
		});
		expect(await rpc.handle({ type: "set_thinking_level", level: "high" })).toMatchObject({ success: true });
		expect(await rpc.handle({ type: "set_model", provider: "faux", model: "faux-2" })).toMatchObject({
			success: true,
		});
		expect(await rpc.handle({ type: "get_snapshot" })).toMatchObject({
			success: true,
			data: { thinkingLevel: "high", model: { provider: "faux", id: "faux-2", name: "Alternate model" } },
		});
		expect(await rpc.handle({ type: "get_available_models" })).toMatchObject({
			success: true,
			data: { models: expect.arrayContaining([expect.objectContaining({ provider: "faux", id: "faux-2" })]) },
		});
		expect(await rpc.handle({ type: "get_available_thinking_levels" })).toMatchObject({
			success: true,
			data: { levels: expect.arrayContaining(["off"]) },
		});
		expect(await rpc.handle({ type: "cycle_model" })).toMatchObject({
			success: true,
			data: { model: { provider: "faux", id: "faux-3" }, isScoped: true },
		});
		expect(await rpc.handle({ type: "cycle_thinking_level" })).toMatchObject({
			success: true,
			data: { level: "off" },
		});
		expect(await rpc.handle({ type: "set_active_tools", names: [] })).toMatchObject({ success: true });
		expect(changedModels).toEqual(["faux-2", "faux-3"]);
		expect(changedThinkingLevels).toEqual(["high", "off"]);
		expect(changedToolSets).toEqual([[]]);
		expect(events.some((event) => event.type === "agent_event" && event.event.type === "agent_end")).toBe(true);
		expect(
			events.some(
				(event) =>
					event.type === "runtime_snapshot" && event.snapshot.projection.messages.at(-1)?.role === "assistant",
			),
		).toBe(true);

		await rpc.dispose();
		await rm(cwd, { recursive: true, force: true });
	});
});

describe("Harness RPC approval bridge", () => {
	it("round-trips an approval request through the RPC command dispatcher", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-harness-rpc-approval-"));
		const approval = new HarnessRpcApprovalService();
		const events: HarnessRpcEvent[] = [];
		const runtime = await createCodingRuntime({
			cwd,
			sessionsRoot: join(cwd, ".sessions"),
			sessionId: "approval",
			streamFn: idleStreamFn,
			toolNames: [],
			includeDefaultSkills: false,
			compaction: {
				settings: { enabled: false, reserveTokens: 100, keepRecentTokens: 0 },
				execute: async () => {
					throw new Error("not used");
				},
			},
		});
		const rpc = await HarnessRpcSession.create(
			runtime,
			(event) => {
				events.push(event);
			},
			{ approval },
		);
		try {
			const decision = approval.requestApproval({ id: "tool-1", name: "write", args: { path: "x" } });
			await Promise.resolve();
			expect(events).toContainEqual({
				type: "approval_request",
				request: { id: "tool-1", name: "write", args: { path: "x" } },
			});
			expect(
				await rpc.handle({
					id: "answer-1",
					type: "approval_response",
					requestId: "tool-1",
					decision: "allow",
				}),
			).toMatchObject({ id: "answer-1", success: true });
			expect(await decision).toEqual({ decision: "allow" });
			expect(await rpc.handle({ type: "invoke_command", name: "missing" })).toMatchObject({
				success: false,
				error: "Unknown Extension command: missing",
			});
		} finally {
			await rpc.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("denies unresolved approvals when the client disconnects", async () => {
		const approval = new HarnessRpcApprovalService();
		approval.bind(() => undefined);
		const pending = approval.requestApproval({ id: "tool-disconnected", name: "write", args: {} });
		approval.close("client disconnected");
		expect(await pending).toEqual({ decision: "deny", reason: "client disconnected" });
	});
});

describe("Harness RPC Extension UI bridge", () => {
	it("round-trips dialogs and cancels pending requests on disposal", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-harness-rpc-extension-ui-"));
		const extensionUI = new HarnessRpcExtensionUIService();
		const events: HarnessRpcEvent[] = [];
		const runtime = await createCodingRuntime({
			cwd,
			sessionsRoot: join(cwd, ".sessions"),
			sessionId: "extension-ui",
			streamFn: idleStreamFn,
			toolNames: [],
			includeDefaultSkills: false,
			compaction: {
				settings: { enabled: false, reserveTokens: 100, keepRecentTokens: 0 },
				execute: async () => {
					throw new Error("not used");
				},
			},
		});
		const rpc = await HarnessRpcSession.create(
			runtime,
			(event) => {
				events.push(event);
			},
			{ extensionUI },
		);
		try {
			const selected = extensionUI.context.select("Choose", ["a", "b"]);
			const request = events.find((event) => event.type === "extension_ui_request" && event.method === "select");
			if (!request || request.method !== "select") throw new Error("Expected Extension UI select request");
			expect(request).toMatchObject({ title: "Choose", options: ["a", "b"] });
			expect(await rpc.handle({ type: "extension_ui_response", id: request.id, value: "b" })).toMatchObject({
				success: true,
			});
			expect(await selected).toBe("b");

			extensionUI.context.notify("Saved", "info");
			expect(events).toContainEqual(
				expect.objectContaining({ type: "extension_ui_request", method: "notify", message: "Saved" }),
			);
			const pendingConfirmation = extensionUI.context.confirm("Confirm", "Continue?");
			await rpc.dispose();
			expect(await pendingConfirmation).toBe(false);
		} finally {
			await rpc.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
