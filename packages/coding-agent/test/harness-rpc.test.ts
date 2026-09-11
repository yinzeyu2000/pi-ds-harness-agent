import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompactionPreparation, StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createCodingRuntime } from "../src/core/coding-runtime.ts";
import { type HarnessRpcEvent, HarnessRpcSession } from "../src/modes/rpc/harness-rpc.ts";
import { HarnessRpcApprovalService } from "../src/modes/rpc/harness-rpc-approval.ts";

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

describe("Harness RPC control protocol", () => {
	it("dispatches commands and emits durable snapshots without a second session state", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-harness-rpc-"));
		const events: HarnessRpcEvent[] = [];
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
		const runtime = await createCodingRuntime({
			cwd,
			sessionsRoot: join(cwd, ".sessions"),
			sessionId: "rpc",
			streamFn,
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
