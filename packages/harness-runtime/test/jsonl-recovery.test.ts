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
import { afterEach, describe, expect, it } from "vitest";
import { createMinimalRuntime } from "../src/minimal-runtime.ts";
import { PiAgentDriver, PiAgentRecoveryError } from "../src/pi-agent-driver.ts";

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

async function reopen(repo: JsonlSessionRepo, metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
	return repo.open(metadata);
}

afterEach(() => {
	while (tempDirectories.length > 0) rmSync(tempDirectories.pop()!, { recursive: true, force: true });
});

describe("PiAgentDriver JSONL recovery", () => {
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

	it("blocks an unresolved tool call as outcome_unknown without replaying effects", async () => {
		const { cwd, repo } = createRepository();
		const session = await repo.create({ id: "unknown-tool", cwd });
		const prompt = userMessage("write something");
		await startOperation(session, "run-unknown-tool", prompt);
		await session.appendMessage(prompt);
		await session.appendMessage(
			assistantMessage(
				[{ type: "toolCall", id: "call-1", name: "write_file", arguments: { path: "result.txt" } }],
				"toolUse",
			),
		);
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
					parameters: { type: "object", properties: {} },
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
