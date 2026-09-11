import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createCodingRuntime } from "../src/core/coding-runtime.ts";
import { parseHarnessRpcCommand, runHarnessRpcMode } from "../src/modes/rpc/harness-rpc-mode.ts";

describe("Harness RPC JSONL mode", () => {
	it("serializes commands, validation failures, events, and responses over strict JSONL", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-harness-rpc-mode-"));
		const lines: string[] = [];
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "transport response" }],
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
			sessionId: "rpc-mode",
			streamFn,
			toolNames: [],
			includeDefaultSkills: false,
			compaction: {
				settings: { enabled: false, reserveTokens: 100, keepRecentTokens: 0 },
				execute: async () => {
					throw new Error("not used");
				},
			},
		});
		const input = Readable.from([
			'{"id":"bad","type":"prompt","message":1}\n',
			'{"id":"p1","type":"prompt","message":"hello"}\n',
			'{"id":"s1","type":"get_snapshot"}\n',
		]);

		try {
			expect(
				await runHarnessRpcMode(runtime, {
					input,
					write: (text) => {
						lines.push(text);
					},
					flush: () => undefined,
				}),
			).toBe(0);
			const records = lines.flatMap((line) => line.trim().split("\n")).map((line) => JSON.parse(line));
			expect(records).toContainEqual({
				id: "bad",
				type: "response",
				command: "prompt",
				success: false,
				error: "prompt requires a string message",
			});
			expect(records).toContainEqual(
				expect.objectContaining({ id: "p1", type: "response", command: "prompt", success: true }),
			);
			expect(records.some((record) => record.type === "agent_event" && record.event.type === "agent_end")).toBe(
				true,
			);
			expect(
				records.some(
					(record) =>
						record.type === "runtime_snapshot" &&
						record.snapshot.projection.messages.at(-1)?.content[0]?.text === "transport response",
				),
			).toBe(true);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("parses supported commands and rejects unknown commands", () => {
		expect(parseHarnessRpcCommand('{"id":"1","type":"compact","customInstructions":"short"}')).toEqual({
			id: "1",
			type: "compact",
			customInstructions: "short",
		});
		expect(parseHarnessRpcCommand('{"id":"bye","type":"shutdown"}')).toEqual({
			id: "bye",
			type: "shutdown",
		});
		expect(parseHarnessRpcCommand('{"type":"set_active_tools","names":["read"]}')).toEqual({
			type: "set_active_tools",
			names: ["read"],
		});
		expect(parseHarnessRpcCommand('{"type":"navigate","entryId":null}')).toEqual({
			type: "navigate",
			entryId: null,
		});
		expect(
			parseHarnessRpcCommand('{"type":"fork_session","sessionId":"forked","entryId":"entry","position":"at"}'),
		).toEqual({ type: "fork_session", sessionId: "forked", entryId: "entry", position: "at" });
		expect(parseHarnessRpcCommand('{"type":"set_model","provider":"faux","model":"faux-2"}')).toEqual({
			type: "set_model",
			provider: "faux",
			model: "faux-2",
		});
		expect(() => parseHarnessRpcCommand('{"type":"unknown"}')).toThrow("Unknown Harness RPC command");
	});

	it("shuts down without waiting for the client stream to close", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-harness-rpc-shutdown-"));
		const input = new PassThrough();
		const lines: string[] = [];
		const runtime = await createCodingRuntime({
			cwd,
			sessionsRoot: join(cwd, ".sessions"),
			sessionId: "shutdown",
			streamFn: () => {
				throw new Error("not used");
			},
			toolNames: [],
			includeDefaultSkills: false,
			compaction: {
				settings: { enabled: false, reserveTokens: 100, keepRecentTokens: 0 },
				execute: async () => {
					throw new Error("not used");
				},
			},
		});
		try {
			const running = runHarnessRpcMode(runtime, {
				input,
				write: (text) => {
					lines.push(text);
				},
				flush: () => undefined,
			});
			input.write('{"id":"bye","type":"shutdown"}\n{"id":"ignored","type":"prompt","message":"must not run"}\n');
			expect(await running).toBe(0);
			expect(lines.join("")).toContain('"id":"bye"');
			expect(lines.join("")).toContain('"command":"shutdown"');
			expect(lines.join("")).not.toContain('"id":"ignored"');
		} finally {
			input.destroy();
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
