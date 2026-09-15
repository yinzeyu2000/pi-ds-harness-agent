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
	it("keeps response order across a burst of valid and invalid commands with async writes", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-harness-rpc-burst-"));
		const lines: string[] = [];
		const runtime = await createCodingRuntime({
			cwd,
			sessionsRoot: join(cwd, ".sessions"),
			sessionId: "rpc-burst",
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
		const commands = Array.from({ length: 64 }, (_, index) =>
			index % 2 === 0
				? JSON.stringify({ id: String(index), type: "get_snapshot" })
				: JSON.stringify({ id: String(index), type: "prompt", message: index }),
		).join("\n");
		try {
			expect(
				await runHarnessRpcMode(runtime, {
					input: Readable.from([`${commands}\n`]),
					write: async (text) => {
						await Promise.resolve();
						lines.push(text);
					},
					flush: () => undefined,
				}),
			).toBe(0);
			const responses = lines
				.flatMap((line) => line.trim().split("\n"))
				.map((line) => JSON.parse(line) as { id?: string; type: string; success?: boolean })
				.filter((record) => record.type === "response");
			expect(responses.map(({ id }) => id)).toEqual(Array.from({ length: 64 }, (_, index) => String(index)));
			expect(responses.filter(({ success }) => success)).toHaveLength(32);
			expect(responses.filter(({ success }) => success === false)).toHaveLength(32);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

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
		expect(parseHarnessRpcCommand('{"type":"clear_queue"}')).toEqual({ type: "clear_queue" });
		expect(parseHarnessRpcCommand('{"type":"export_html","outputPath":"out/session.html"}')).toEqual({
			type: "export_html",
			outputPath: "out/session.html",
		});
		expect(parseHarnessRpcCommand('{"type":"extension_ui_response","id":"ui-1","confirmed":true}')).toEqual({
			type: "extension_ui_response",
			id: "ui-1",
			confirmed: true,
		});
		expect(parseHarnessRpcCommand('{"type":"new_session","sessionId":"child","parentSession":"parent"}')).toEqual({
			type: "new_session",
			sessionId: "child",
			parentSession: "parent",
		});
		expect(parseHarnessRpcCommand('{"type":"get_available_models"}')).toEqual({
			type: "get_available_models",
		});
		expect(parseHarnessRpcCommand('{"type":"get_session_stats"}')).toEqual({ type: "get_session_stats" });
		expect(parseHarnessRpcCommand('{"type":"get_last_assistant_text"}')).toEqual({
			type: "get_last_assistant_text",
		});
		expect(parseHarnessRpcCommand('{"type":"get_entries","since":"entry-1"}')).toEqual({
			type: "get_entries",
			since: "entry-1",
		});
		expect(parseHarnessRpcCommand('{"type":"get_fork_messages"}')).toEqual({ type: "get_fork_messages" });
		expect(parseHarnessRpcCommand('{"type":"clone","sessionId":"copy"}')).toEqual({
			type: "clone",
			sessionId: "copy",
		});
		expect(parseHarnessRpcCommand('{"type":"get_available_thinking_levels"}')).toEqual({
			type: "get_available_thinking_levels",
		});
		expect(parseHarnessRpcCommand('{"type":"cycle_model"}')).toEqual({ type: "cycle_model" });
		expect(parseHarnessRpcCommand('{"type":"cycle_thinking_level"}')).toEqual({
			type: "cycle_thinking_level",
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
			parseHarnessRpcCommand(
				'{"type":"navigate","entryId":"target","summarize":true,"customInstructions":"focus","label":"branch"}',
			),
		).toEqual({
			type: "navigate",
			entryId: "target",
			summarize: true,
			customInstructions: "focus",
			label: "branch",
		});
		expect(parseHarnessRpcCommand('{"type":"switch_session","sessionId":"other","cwd":"D:/other"}')).toEqual({
			type: "switch_session",
			sessionId: "other",
			cwd: "D:/other",
		});
		expect(
			parseHarnessRpcCommand('{"type":"fork_session","sessionId":"forked","entryId":"entry","position":"at"}'),
		).toEqual({ type: "fork_session", sessionId: "forked", entryId: "entry", position: "at" });
		expect(parseHarnessRpcCommand('{"type":"set_model","provider":"faux","model":"faux-2"}')).toEqual({
			type: "set_model",
			provider: "faux",
			model: "faux-2",
		});
		expect(parseHarnessRpcCommand('{"type":"set_model","provider":"faux","modelId":"legacy-id"}')).toEqual({
			type: "set_model",
			provider: "faux",
			model: "legacy-id",
		});
		expect(() => parseHarnessRpcCommand('{"type":"unknown"}')).toThrow("Unknown Harness RPC command");
		expect(() => parseHarnessRpcCommand('{"type":"navigate","entryId":"target","summarize":"yes"}')).toThrow(
			"navigate summarize must be a boolean",
		);
		expect(() => parseHarnessRpcCommand('{"type":"switch_session","sessionId":"other","cwd":1}')).toThrow(
			"switch_session cwd must be a string",
		);
		expect(() => parseHarnessRpcCommand('{"type":"export_html","outputPath":1}')).toThrow(
			"export_html outputPath must be a string",
		);
		expect(() => parseHarnessRpcCommand('{"type":"extension_ui_response","id":"ui-1"}')).toThrow(
			"extension_ui_response requires value, confirmed, or cancelled",
		);
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

	it("aborts an active prompt before completing shutdown and ignores trailing commands", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-harness-rpc-active-shutdown-"));
		const input = new PassThrough();
		const lines: string[] = [];
		let resolveStarted: () => void = () => undefined;
		const started = new Promise<void>((resolve) => {
			resolveStarted = resolve;
		});
		const runtime = await createCodingRuntime({
			cwd,
			sessionsRoot: join(cwd, ".sessions"),
			sessionId: "active-shutdown",
			streamFn: (_model, _context, options) => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({
						type: "start",
						partial: {
							role: "assistant",
							content: [],
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
							stopReason: "pending",
							timestamp: Date.now(),
						},
					});
					resolveStarted();
					const abort = () =>
						stream.push({
							type: "error",
							reason: "aborted",
							error: {
								role: "assistant",
								content: [],
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
								stopReason: "aborted",
								timestamp: Date.now(),
							},
						});
					if (options?.signal?.aborted) abort();
					else options?.signal?.addEventListener("abort", abort, { once: true });
				});
				return stream;
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
			input.write('{"id":"run","type":"prompt","message":"wait"}\n');
			await started;
			input.write('{"id":"stop","type":"shutdown"}\n{"id":"ignored","type":"get_snapshot"}\n');
			expect(await running).toBe(0);
			const output = lines.join("");
			expect(output).toContain('"id":"run"');
			expect(output).toContain('"id":"stop"');
			expect(output).not.toContain('"id":"ignored"');
			expect(output).toContain('"stopReason":"aborted"');
			expect(output).toContain('"recovery":{"status":"idle"}');
		} finally {
			input.destroy();
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
