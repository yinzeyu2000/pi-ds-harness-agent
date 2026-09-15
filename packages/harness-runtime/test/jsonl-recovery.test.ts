import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentMessage,
	type JsonlSessionMetadata,
	JsonlSessionRepo,
	NodeExecutionEnv,
	type Session,
	type StreamFn,
} from "@earendil-works/pi-agent-core/node";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createMinimalRuntime } from "../src/minimal-runtime.ts";
import {
	type DriverCompactionService,
	PiAgentDriver,
	PiAgentRecoveryError,
	REQUEST_CONFIGURATION_CUSTOM_TYPE,
} from "../src/pi-agent-driver.ts";

const tempDirectories: string[] = [];

function createRepository(): { cwd: string; repo: JsonlSessionRepo } {
	const root = mkdtempSync(join(tmpdir(), "pi-ds-jsonl-recovery-"));
	tempDirectories.push(root);
	return {
		cwd: root,
		repo: new JsonlSessionRepo({
			fs: new NodeExecutionEnv({ cwd: root }),
			sessionsRoot: join(root, "sessions"),
		}),
	};
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
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
	};
}

function responseStream(text: string, onRequest?: () => void): StreamFn {
	return () => {
		onRequest?.();
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "done", reason: "stop", message: assistantMessage([{ type: "text", text }]) });
		});
		return stream;
	};
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

async function startOperation(session: Session, runId: string, prompt: AgentMessage): Promise<void> {
	await session.appendRecord({
		type: "operation_started",
		id: runId,
		lane: "main",
		sourceLeafId: await session.getLeafId(),
		intent: { kind: "run", originalPrompt: [prompt], initialMessages: [] },
	});
}

async function startAnchoredOperation(
	session: Session,
	runId: string,
	prompt: AgentMessage,
	systemPrompt: string,
): Promise<void> {
	const sourceLeafId = await session.appendCustomEntry(REQUEST_CONFIGURATION_CUSTOM_TYPE, {
		schemaVersion: 1,
		runId,
		systemPrompt,
		model: { provider: "unknown", id: "unknown" },
		thinkingLevel: "off",
		tools: [],
	});
	await session.appendRecord({
		type: "operation_started",
		id: runId,
		lane: "main",
		sourceLeafId,
		intent: { kind: "run", originalPrompt: [prompt], initialMessages: [], systemPromptOverride: systemPrompt },
	});
}

async function reopen(repo: JsonlSessionRepo, metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
	return repo.open(metadata);
}

function navigationService(onSummarize: (entries: readonly AgentMessage[]) => void): DriverCompactionService {
	return {
		settings: { enabled: false, reserveTokens: 100, keepRecentTokens: 0 },
		execute: async () => {
			throw new Error("not used");
		},
		summarizeBranch: async (entries) => {
			onSummarize(entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])));
			return {
				summary: "Recovered abandoned branch",
				readFiles: ["read.ts"],
				modifiedFiles: ["edited.ts"],
			};
		},
	};
}

afterEach(() => {
	while (tempDirectories.length > 0) rmSync(tempDirectories.pop()!, { recursive: true, force: true });
});

describe("PiAgentDriver JSONL recovery", () => {
	it("resumes summarized navigation after its durable intent without losing the old branch", async () => {
		const { cwd, repo } = createRepository();
		const session = await repo.create({ id: "navigation-intent", cwd });
		const targetId = await session.appendMessage(userMessage("common target"));
		const sourceLeafId = await session.appendMessage(userMessage("abandoned work"));
		await session.appendRecord({
			type: "operation_started",
			id: "navigation-run",
			lane: "main",
			sourceLeafId,
			intent: {
				kind: "navigation",
				targetId,
				summarize: true,
				customInstructions: "preserve decisions",
				summaryEntryId: "navigation-summary",
			},
		});
		const reopened = await reopen(repo, await session.getMetadata());
		let summarizedMessages: readonly AgentMessage[] = [];
		const driver = await PiAgentDriver.create({
			session: reopened,
			streamFn: responseStream("unused"),
			compaction: navigationService((messages) => {
				summarizedMessages = messages;
			}),
		});

		expect(await driver.getRecoveryState()).toEqual({
			status: "resumable",
			runId: "navigation-run",
			point: "navigation",
		});
		await driver.resume();

		expect(summarizedMessages).toHaveLength(1);
		expect(summarizedMessages[0]).toMatchObject({ role: "user", content: "abandoned work" });
		expect(await reopened.getEntry("navigation-summary")).toMatchObject({
			type: "branch_summary",
			parentId: targetId,
			fromId: sourceLeafId,
			summary: "Recovered abandoned branch",
			details: { readFiles: ["read.ts"], modifiedFiles: ["edited.ts"] },
		});
		expect(await reopened.findOpenOperations("main")).toEqual([]);
		expect((await reopened.findRecords({ type: "operation_finished" }))[0]?.outcome).toBe("completed");
		await driver.dispose();
	});

	it("settles a navigation summary committed before its terminal without summarizing twice", async () => {
		const { cwd, repo } = createRepository();
		const session = await repo.create({ id: "navigation-summary-tail", cwd });
		const targetId = await session.appendMessage(userMessage("target"));
		const sourceLeafId = await session.appendMessage(userMessage("old branch"));
		await session.appendRecord({
			type: "operation_started",
			id: "navigation-summary-tail-run",
			lane: "main",
			sourceLeafId,
			intent: {
				kind: "navigation",
				targetId,
				summarize: true,
				summaryEntryId: "durable-navigation-summary",
			},
		});
		await session.moveLane("main", targetId);
		await session.appendEntry(
			{
				type: "branch_summary",
				id: "durable-navigation-summary",
				fromId: sourceLeafId,
				summary: "already durable",
			},
			"main",
		);
		const reopened = await reopen(repo, await session.getMetadata());
		let summaryCalls = 0;
		const driver = await PiAgentDriver.create({
			session: reopened,
			streamFn: responseStream("unused"),
			compaction: navigationService(() => summaryCalls++),
		});

		expect(await driver.getRecoveryState()).toEqual({
			status: "settleable",
			runId: "navigation-summary-tail-run",
			outcome: "completed",
		});
		await driver.resume();

		expect(summaryCalls).toBe(0);
		expect(await reopened.findOpenOperations("main")).toEqual([]);
		expect(await reopened.findEntries({ type: "branch_summary" })).toHaveLength(1);
		await driver.dispose();
	});

	it("settles a durable compaction result without generating the summary twice", async () => {
		const { cwd, repo } = createRepository();
		const session = await repo.create({ id: "compaction-result-tail", cwd });
		const sourceLeafId = await session.appendMessage(userMessage("source context"));
		await session.appendRecord({
			type: "operation_started",
			id: "compaction-result-tail-run",
			lane: "main",
			sourceLeafId,
			intent: {
				kind: "compaction",
				customInstructions: "preserve decisions",
				resultEntryId: "durable-compaction-result",
			},
		});
		await session.appendRecord({
			type: "step_attempt",
			id: "compaction-attempt",
			lane: "main",
			runId: "compaction-result-tail-run",
			step: "compaction",
			attempt: 1,
			resultEntryId: "durable-compaction-result",
			compactionReason: "manual",
		});
		await session.appendEntry(
			{
				type: "compaction",
				id: "durable-compaction-result",
				summary: "already durable",
				retainedTail: [],
				tokensBefore: 12,
			},
			"main",
		);
		const reopened = await reopen(repo, await session.getMetadata());
		let requestCount = 0;
		const driver = await PiAgentDriver.create({
			session: reopened,
			streamFn: responseStream("unused", () => requestCount++),
		});

		expect(await driver.getRecoveryState()).toEqual({
			status: "settleable",
			runId: "compaction-result-tail-run",
			outcome: "completed",
		});
		await driver.resume();

		expect(requestCount).toBe(0);
		expect(await reopened.findOpenOperations("main")).toEqual([]);
		expect(await reopened.findEntries({ type: "compaction" })).toHaveLength(1);
		expect((await reopened.findRecords({ type: "operation_finished" }))[0]?.outcome).toBe("completed");
		await driver.dispose();
	});

	it("does not retry compaction before its result is durable", async () => {
		const { cwd, repo } = createRepository();
		const session = await repo.create({ id: "compaction-missing-result", cwd });
		const sourceLeafId = await session.appendMessage(userMessage("source context"));
		await session.appendRecord({
			type: "operation_started",
			id: "compaction-missing-result-run",
			lane: "main",
			sourceLeafId,
			intent: { kind: "compaction", resultEntryId: "missing-compaction-result" },
		});
		const reopened = await reopen(repo, await session.getMetadata());
		let requestCount = 0;
		const driver = await PiAgentDriver.create({
			session: reopened,
			streamFn: responseStream("unused", () => requestCount++),
		});

		expect(await driver.getRecoveryState()).toMatchObject({
			status: "blocked",
			runId: "compaction-missing-result-run",
			code: "unsupported_operation",
		});
		await expect(driver.resume()).rejects.toMatchObject({ code: "unsupported_operation" });
		expect(requestCount).toBe(0);
		expect(await reopened.findOpenOperations("main")).toHaveLength(1);
		await driver.dispose();
	});

	it("blocks recovery when the model-visible request configuration drifts", async () => {
		const { cwd, repo } = createRepository();
		const session = await repo.create({ id: "configuration-drift", cwd });
		await startAnchoredOperation(session, "run-configuration-drift", userMessage("recover me"), "original");
		const reopened = await reopen(repo, await session.getMetadata());
		let requestCount = 0;
		const runtime = await createMinimalRuntime({
			session: reopened,
			streamFn: responseStream("unexpected", () => requestCount++),
			systemPrompt: "changed",
			thinkingLevel: "high",
		});

		expect(await runtime.driver.getRecoveryState()).toMatchObject({
			status: "blocked",
			runId: "run-configuration-drift",
			code: "configuration_mismatch",
		});
		await expect(runtime.driver.resume()).rejects.toMatchObject({ code: "configuration_mismatch" });
		expect(requestCount).toBe(0);
		expect(await reopened.findOpenOperations("main")).toHaveLength(1);
		await runtime.dispose();
	});

	it("reopens a completed JSONL session without creating recovery work", async () => {
		const { cwd, repo } = createRepository();
		const session = await repo.create({ id: "completed", cwd });
		const firstRuntime = await createMinimalRuntime({ session, streamFn: responseStream("complete") });
		await firstRuntime.driver.prompt("hello");
		const metadata = await session.getMetadata();
		await firstRuntime.dispose();

		let requestCount = 0;
		const reopened = await reopen(repo, metadata);
		const secondRuntime = await createMinimalRuntime({
			session: reopened,
			streamFn: responseStream("unexpected", () => requestCount++),
		});

		expect(await secondRuntime.driver.getRecoveryState()).toEqual({ status: "idle" });
		expect(secondRuntime.driver.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(requestCount).toBe(0);
		await secondRuntime.dispose();
	});

	it("resumes from an operation start that was committed before its prompt", async () => {
		const { cwd, repo } = createRepository();
		const session = await repo.create({ id: "start-only", cwd });
		await startOperation(session, "run-start-only", userMessage("recover me"));
		const reopened = await reopen(repo, await session.getMetadata());
		let requestCount = 0;
		const runtime = await createMinimalRuntime({
			session: reopened,
			streamFn: responseStream("recovered", () => requestCount++),
		});

		expect(await runtime.driver.getRecoveryState()).toEqual({
			status: "resumable",
			runId: "run-start-only",
			point: "operation_start",
		});
		await expect(runtime.driver.prompt("new prompt")).rejects.toMatchObject({ code: "resume_required" });
		expect(await reopened.findOpenOperations("main")).toHaveLength(1);
		await runtime.driver.resume();

		expect(requestCount).toBe(1);
		expect(runtime.driver.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(await reopened.findOpenOperations("main")).toEqual([]);
		expect((await reopened.findRecords({ type: "operation_finished" }))[0]?.outcome).toBe("completed");
		await runtime.dispose();
	});

	it("continues after a durable user message without appending it twice", async () => {
		const { cwd, repo } = createRepository();
		const session = await repo.create({ id: "message-tail", cwd });
		const prompt = userMessage("already durable");
		await startOperation(session, "run-message-tail", prompt);
		await session.appendMessage(prompt);
		const reopened = await reopen(repo, await session.getMetadata());
		const runtime = await createMinimalRuntime({ session: reopened, streamFn: responseStream("continued") });

		expect(await runtime.driver.getRecoveryState()).toEqual({
			status: "resumable",
			runId: "run-message-tail",
			point: "message_tail",
		});
		await runtime.driver.resume();

		const messages = await reopened.findEntries({ type: "message", order: "oldestFirst" });
		expect(messages.map((entry) => entry.type === "message" && entry.message.role)).toEqual(["user", "assistant"]);
		await runtime.dispose();
	});

	it("settles a durable final assistant response without calling the model again", async () => {
		const { cwd, repo } = createRepository();
		const session = await repo.create({ id: "assistant-tail", cwd });
		const prompt = userMessage("finish the record");
		await startOperation(session, "run-assistant-tail", prompt);
		await session.appendMessage(prompt);
		await session.appendMessage(assistantMessage([{ type: "text", text: "already complete" }]));
		const reopened = await reopen(repo, await session.getMetadata());
		let requestCount = 0;
		const runtime = await createMinimalRuntime({
			session: reopened,
			streamFn: responseStream("unexpected", () => requestCount++),
		});

		expect(await runtime.driver.getRecoveryState()).toEqual({
			status: "settleable",
			runId: "run-assistant-tail",
			outcome: "completed",
		});
		await runtime.driver.resume();

		expect(requestCount).toBe(0);
		expect((await reopened.findRecords({ type: "operation_finished" }))[0]?.outcome).toBe("completed");
		await runtime.dispose();
	});

	it("settles a durable abort request without restarting the operation", async () => {
		const { cwd, repo } = createRepository();
		const session = await repo.create({ id: "abort-tail", cwd });
		await startOperation(session, "run-abort-tail", userMessage("do not restart"));
		await session.appendRecord({
			type: "abort_requested",
			id: "abort-request",
			lane: "main",
			runId: "run-abort-tail",
		});
		const reopened = await reopen(repo, await session.getMetadata());
		let requestCount = 0;
		const runtime = await createMinimalRuntime({
			session: reopened,
			streamFn: responseStream("unexpected", () => requestCount++),
		});

		expect(await runtime.driver.getRecoveryState()).toEqual({
			status: "settleable",
			runId: "run-abort-tail",
			outcome: "aborted",
		});
		await runtime.driver.resume();

		expect(requestCount).toBe(0);
		expect((await reopened.findRecords({ type: "operation_finished" }))[0]?.outcome).toBe("aborted");
		await runtime.dispose();
	});

	it("settles a durable assistant error with its recovery classification", async () => {
		const { cwd, repo } = createRepository();
		const session = await repo.create({ id: "error-tail", cwd });
		const prompt = userMessage("fail once");
		await startOperation(session, "run-error-tail", prompt);
		await session.appendMessage(prompt);
		await session.appendMessage({
			...assistantMessage([], "error"),
			errorMessage: "provider unavailable",
		});
		const reopened = await reopen(repo, await session.getMetadata());
		let requestCount = 0;
		const runtime = await createMinimalRuntime({
			session: reopened,
			streamFn: responseStream("unexpected", () => requestCount++),
		});

		expect(await runtime.driver.getRecoveryState()).toEqual({
			status: "settleable",
			runId: "run-error-tail",
			outcome: "failed",
			error: { code: "assistant_error", message: "provider unavailable" },
		});
		await runtime.driver.resume();

		expect(requestCount).toBe(0);
		expect((await reopened.findRecords({ type: "operation_finished" }))[0]).toMatchObject({
			outcome: "failed",
			error: { code: "assistant_error", message: "provider unavailable" },
		});
		await runtime.dispose();
	});

	it("replays a started safe tool, commits its reserved result, and continues the model", async () => {
		const { cwd, repo } = createRepository();
		const session = await repo.create({ id: "safe-tool", cwd });
		const parameters = Type.Object({});
		const sourceLeafId = await session.appendCustomEntry(REQUEST_CONFIGURATION_CUSTOM_TYPE, {
			schemaVersion: 1,
			runId: "run-safe-tool",
			systemPrompt: "system",
			model: { provider: "unknown", id: "unknown" },
			thinkingLevel: "off",
			tools: [
				{
					name: "read_version",
					description: "Read the version",
					parameters: { type: "object", properties: {} },
					replay: "safe",
				},
			],
		});
		const prompt = userMessage("read it");
		await session.appendRecord({
			type: "operation_started",
			id: "run-safe-tool",
			lane: "main",
			sourceLeafId,
			intent: { kind: "run", originalPrompt: [prompt], initialMessages: [], systemPromptOverride: "system" },
		});
		await session.appendMessage(prompt);
		const assistantEntryId = await session.appendMessage(
			assistantMessage([{ type: "toolCall", id: "call-safe", name: "read_version", arguments: {} }], "toolUse"),
		);
		await session.appendRecord({
			type: "tool_started",
			id: "tool-start-safe",
			lane: "main",
			runId: "run-safe-tool",
			assistantEntryId,
			toolIndex: 0,
			toolCallId: "call-safe",
			toolName: "read_version",
			effectiveArgs: {},
			resultEntryId: "tool-result-safe",
			replay: "safe",
		});
		const reopened = await reopen(repo, await session.getMetadata());
		let requestCount = 0;
		let toolCallCount = 0;
		const runtime = await createMinimalRuntime({
			session: reopened,
			streamFn: responseStream("continued", () => requestCount++),
			systemPrompt: "system",
			tools: [
				{
					name: "read_version",
					label: "Read version",
					description: "Read the version",
					parameters,
					execute: async () => {
						toolCallCount++;
						return { content: [{ type: "text", text: "0.1.0" }], details: {} };
					},
				},
			],
			toolReplay: { read_version: "safe" },
		});

		expect(await runtime.driver.getRecoveryState()).toEqual({
			status: "resumable",
			runId: "run-safe-tool",
			point: "tool_batch",
		});
		await runtime.driver.resume();

		expect(toolCallCount).toBe(1);
		expect(requestCount).toBe(1);
		expect(runtime.driver.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(await reopened.getEntry("tool-result-safe")).toMatchObject({
			type: "message",
			message: { role: "toolResult", toolCallId: "call-safe", isError: false },
		});
		expect(await reopened.findOpenOperations("main")).toEqual([]);
		await runtime.dispose();
	});

	it("continues after a durable ToolResult without executing the tool again", async () => {
		const { cwd, repo } = createRepository();
		const session = await repo.create({ id: "tool-result-tail", cwd });
		const parameters = Type.Object({});
		const sourceLeafId = await session.appendCustomEntry(REQUEST_CONFIGURATION_CUSTOM_TYPE, {
			schemaVersion: 1,
			runId: "run-tool-result-tail",
			systemPrompt: "system",
			model: { provider: "unknown", id: "unknown" },
			thinkingLevel: "off",
			tools: [
				{
					name: "read_version",
					description: "Read the version",
					parameters: { type: "object", properties: {} },
					replay: "safe",
				},
			],
		});
		const prompt = userMessage("read it");
		await session.appendRecord({
			type: "operation_started",
			id: "run-tool-result-tail",
			lane: "main",
			sourceLeafId,
			intent: { kind: "run", originalPrompt: [prompt], initialMessages: [], systemPromptOverride: "system" },
		});
		await session.appendMessage(prompt);
		const assistantEntryId = await session.appendMessage(
			assistantMessage([{ type: "toolCall", id: "call-result", name: "read_version", arguments: {} }], "toolUse"),
		);
		await session.appendRecord({
			type: "tool_started",
			id: "tool-start-result",
			lane: "main",
			runId: "run-tool-result-tail",
			assistantEntryId,
			toolIndex: 0,
			toolCallId: "call-result",
			toolName: "read_version",
			effectiveArgs: {},
			resultEntryId: "tool-result-tail",
			replay: "safe",
		});
		await session.appendEntry(
			{
				type: "message",
				id: "tool-result-tail",
				message: {
					role: "toolResult",
					toolCallId: "call-result",
					toolName: "read_version",
					content: [{ type: "text", text: "0.1.0" }],
					details: {},
					isError: false,
					timestamp: Date.now(),
				},
			},
			"main",
		);
		const reopened = await reopen(repo, await session.getMetadata());
		let requestCount = 0;
		let toolCallCount = 0;
		const runtime = await createMinimalRuntime({
			session: reopened,
			streamFn: responseStream("continued", () => requestCount++),
			systemPrompt: "system",
			tools: [
				{
					name: "read_version",
					label: "Read version",
					description: "Read the version",
					parameters,
					execute: async () => {
						toolCallCount++;
						return { content: [{ type: "text", text: "unexpected" }], details: {} };
					},
				},
			],
			toolReplay: { read_version: "safe" },
		});

		expect(await runtime.driver.getRecoveryState()).toEqual({
			status: "resumable",
			runId: "run-tool-result-tail",
			point: "message_tail",
		});
		await runtime.driver.resume();

		expect(toolCallCount).toBe(0);
		expect(requestCount).toBe(1);
		expect(
			(await reopened.findEntries({ type: "message" })).filter((entry) => entry.type === "message"),
		).toHaveLength(4);
		await runtime.dispose();
	});

	it("executes a never-replay tool once when no durable ToolStart exists", async () => {
		const { cwd, repo } = createRepository();
		const session = await repo.create({ id: "before-tool-start", cwd });
		const parameters = Type.Object({});
		const sourceLeafId = await session.appendCustomEntry(REQUEST_CONFIGURATION_CUSTOM_TYPE, {
			schemaVersion: 1,
			runId: "run-before-tool-start",
			systemPrompt: "system",
			model: { provider: "unknown", id: "unknown" },
			thinkingLevel: "off",
			tools: [
				{
					name: "non_idempotent",
					description: "Perform one effect",
					parameters: { type: "object", properties: {} },
					replay: "never",
				},
			],
		});
		const prompt = userMessage("perform it");
		await session.appendRecord({
			type: "operation_started",
			id: "run-before-tool-start",
			lane: "main",
			sourceLeafId,
			intent: { kind: "run", originalPrompt: [prompt], initialMessages: [], systemPromptOverride: "system" },
		});
		await session.appendMessage(prompt);
		await session.appendMessage(
			assistantMessage([{ type: "toolCall", id: "call-first", name: "non_idempotent", arguments: {} }], "toolUse"),
		);
		const reopened = await reopen(repo, await session.getMetadata());
		let toolCallCount = 0;
		const runtime = await createMinimalRuntime({
			session: reopened,
			streamFn: responseStream("continued"),
			systemPrompt: "system",
			tools: [
				{
					name: "non_idempotent",
					label: "Non-idempotent",
					description: "Perform one effect",
					parameters,
					execute: async () => {
						toolCallCount++;
						return { content: [{ type: "text", text: "done" }], details: {} };
					},
				},
			],
		});

		expect(await runtime.driver.getRecoveryState()).toMatchObject({ status: "resumable", point: "tool_batch" });
		await runtime.driver.resume();

		expect(toolCallCount).toBe(1);
		expect(await reopened.findRecords({ type: "tool_started" })).toHaveLength(1);
		expect(
			(await reopened.findEntries({ type: "message" })).filter((entry) => entry.type === "message"),
		).toHaveLength(4);
		await runtime.dispose();
	});

	it("blocks an unresolved tool call as outcome_unknown without replaying effects", async () => {
		const { cwd, repo } = createRepository();
		const session = await repo.create({ id: "unknown-tool", cwd });
		const parameters = Type.Object({});
		const prompt = userMessage("write something");
		const sourceLeafId = await session.appendCustomEntry(REQUEST_CONFIGURATION_CUSTOM_TYPE, {
			schemaVersion: 1,
			runId: "run-unknown-tool",
			systemPrompt: "You are a helpful assistant.",
			model: { provider: "unknown", id: "unknown" },
			thinkingLevel: "off",
			tools: [
				{
					name: "write_file",
					description: "test tool",
					parameters: { type: "object", properties: {} },
					replay: "never",
				},
			],
		});
		await session.appendRecord({
			type: "operation_started",
			id: "run-unknown-tool",
			lane: "main",
			sourceLeafId,
			intent: { kind: "run", originalPrompt: [prompt], initialMessages: [] },
		});
		await session.appendMessage(prompt);
		const assistantEntryId = await session.appendMessage(
			assistantMessage([{ type: "toolCall", id: "call-1", name: "write_file", arguments: {} }], "toolUse"),
		);
		await session.appendRecord({
			type: "tool_started",
			id: "tool-start-never",
			lane: "main",
			runId: "run-unknown-tool",
			assistantEntryId,
			toolIndex: 0,
			toolCallId: "call-1",
			toolName: "write_file",
			effectiveArgs: {},
			resultEntryId: "tool-result-never",
			replay: "never",
		});
		const reopened = await reopen(repo, await session.getMetadata());
		let requestCount = 0;
		let toolCallCount = 0;
		const runtime = await createMinimalRuntime({
			session: reopened,
			streamFn: responseStream("unexpected", () => requestCount++),
			tools: [
				{
					name: "write_file",
					label: "write_file",
					description: "test tool",
					parameters,
					execute: async () => {
						toolCallCount++;
						return { content: [{ type: "text", text: "written" }], details: {} };
					},
				},
			],
		});

		expect(await runtime.driver.getRecoveryState()).toMatchObject({
			status: "blocked",
			runId: "run-unknown-tool",
			code: "outcome_unknown",
		});
		await expect(runtime.driver.resume()).rejects.toBeInstanceOf(PiAgentRecoveryError);
		await expect(runtime.driver.resume()).rejects.toMatchObject({ code: "outcome_unknown" });
		expect(requestCount).toBe(0);
		expect(toolCallCount).toBe(0);
		expect(await reopened.findOpenOperations("main")).toHaveLength(1);
		await runtime.dispose();
	});

	it("reconciles a completed never-replay tool without executing its effect again", async () => {
		const { cwd, repo } = createRepository();
		const session = await repo.create({ id: "reconciled-tool", cwd });
		const parameters = Type.Object({});
		const prompt = userMessage("write something");
		const sourceLeafId = await session.appendCustomEntry(REQUEST_CONFIGURATION_CUSTOM_TYPE, {
			schemaVersion: 1,
			runId: "run-reconciled-tool",
			systemPrompt: "You are a helpful assistant.",
			model: { provider: "unknown", id: "unknown" },
			thinkingLevel: "off",
			reconciliationVersion: "provider-v1",
			tools: [
				{
					name: "write_file",
					description: "test tool",
					parameters: { type: "object", properties: {} },
					replay: "never",
				},
			],
		});
		await session.appendRecord({
			type: "operation_started",
			id: "run-reconciled-tool",
			lane: "main",
			sourceLeafId,
			intent: { kind: "run", originalPrompt: [prompt], initialMessages: [] },
		});
		await session.appendMessage(prompt);
		const assistantEntryId = await session.appendMessage(
			assistantMessage([{ type: "toolCall", id: "call-reconciled", name: "write_file", arguments: {} }], "toolUse"),
		);
		await session.appendRecord({
			type: "tool_started",
			id: "tool-start-reconciled",
			lane: "main",
			runId: "run-reconciled-tool",
			assistantEntryId,
			toolIndex: 0,
			toolCallId: "call-reconciled",
			toolName: "write_file",
			effectiveArgs: {},
			resultEntryId: "tool-result-reconciled",
			replay: "never",
		});
		const reopened = await reopen(repo, await session.getMetadata());
		let requestCount = 0;
		let toolCallCount = 0;
		let reconciliationCount = 0;
		const runtime = await createMinimalRuntime({
			session: reopened,
			streamFn: responseStream("continued", () => requestCount++),
			tools: [
				{
					name: "write_file",
					label: "write_file",
					description: "test tool",
					parameters,
					execute: async () => {
						toolCallCount++;
						return { content: [{ type: "text", text: "unexpected" }], details: {} };
					},
				},
			],
			toolReconciliation: {
				version: "provider-v1",
				service: {
					reconcile(request) {
						reconciliationCount++;
						expect(request).toMatchObject({
							runId: "run-reconciled-tool",
							toolCallId: "call-reconciled",
							resultEntryId: "tool-result-reconciled",
						});
						return {
							status: "completed",
							result: { content: [{ type: "text", text: "already written" }], details: { providerId: "42" } },
						};
					},
				},
			},
		});

		expect(await runtime.driver.getRecoveryState()).toMatchObject({ status: "resumable", point: "tool_batch" });
		await runtime.driver.resume();

		expect(reconciliationCount).toBe(1);
		expect(toolCallCount).toBe(0);
		expect(requestCount).toBe(1);
		expect(await reopened.getEntry("tool-result-reconciled")).toMatchObject({
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "call-reconciled",
				content: [{ type: "text", text: "already written" }],
				isError: false,
			},
		});
		expect(await reopened.findOpenOperations("main")).toEqual([]);
		await runtime.dispose();
	});

	it("restores a durable pending queue item after restart", async () => {
		const { cwd, repo } = createRepository();
		const session = await repo.create({ id: "queued-recovery", cwd });
		const prompt = userMessage("initial");
		await startAnchoredOperation(session, "run-queued-recovery", prompt, "You are a helpful assistant.");
		await session.appendMessage(prompt);
		await session.appendMessage(assistantMessage([{ type: "text", text: "first response" }]));
		await session.appendRecord({
			type: "queue_enqueued",
			id: "queue-record",
			lane: "main",
			runId: "run-queued-recovery",
			queue: "steer",
			target: { type: "message", id: "queued-message", message: userMessage("queued after crash") },
		});
		const reopened = await reopen(repo, await session.getMetadata());
		let requestMessages: AgentMessage[] = [];
		const runtime = await createMinimalRuntime({
			session: reopened,
			streamFn: (_model, context) => {
				requestMessages = structuredClone(context.messages) as AgentMessage[];
				return responseStream("resumed")(_model, context);
			},
		});

		expect(await runtime.driver.getRecoveryState()).toEqual({
			status: "resumable",
			runId: "run-queued-recovery",
			point: "message_tail",
		});
		await runtime.driver.resume();

		expect(requestMessages.at(-1)).toMatchObject({ role: "user", content: "queued after crash" });
		expect(await reopened.getEntry("queued-message")).toMatchObject({
			type: "message",
			message: { role: "user", content: "queued after crash" },
		});
		expect(await reopened.findOpenOperations("main")).toEqual([]);
		await runtime.dispose();
	});

	it("rejects multiple unfinished operations as record-log corruption", async () => {
		const { cwd, repo } = createRepository();
		const session = await repo.create({ id: "multiple-open", cwd });
		await startOperation(session, "run-one", userMessage("one"));
		const metadata = await session.getMetadata();
		appendFileSync(
			metadata.path,
			`${JSON.stringify({
				kind: "record",
				type: "operation_started",
				id: "run-two",
				seq: 2,
				lane: "main",
				timestamp: Date.now(),
				sourceLeafId: null,
				intent: { kind: "run", originalPrompt: [userMessage("two")], initialMessages: [] },
			})}\n`,
		);
		const reopened = await reopen(repo, metadata);

		await expect(
			PiAgentDriver.create({ session: reopened, streamFn: responseStream("unexpected") }),
		).rejects.toMatchObject({
			name: "PiAgentRecoveryError",
			code: "multiple_open_operations",
		});
	});
});
