import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompactionPreparation, StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createCodingRuntime } from "../src/core/coding-runtime.ts";
import {
	createHarnessExtensionContexts,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "../src/core/extensions/index.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { runCodingPrintMode } from "../src/modes/coding-print-mode.ts";

const compaction = {
	settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 0 },
	execute: async (preparation: CompactionPreparation) => ({
		summary: "summary",
		tokensBefore: preparation.tokensBefore,
		retainedTail: preparation.retainedTail,
	}),
};

const streamFn: StreamFn = () => {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({
			type: "done",
			reason: "stop",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "canonical output" }],
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
	});
	return stream;
};

describe("Coding Runtime print mode", () => {
	it("prints the final response and restores the identical canonical session", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-print-mode-"));
		const sessionsRoot = join(cwd, ".sessions");
		let restored: Awaited<ReturnType<typeof createCodingRuntime>> | undefined;
		try {
			const runtime = await createCodingRuntime({
				cwd,
				sessionsRoot,
				sessionId: "print-mode",
				streamFn,
				toolNames: [],
				includeDefaultSkills: false,
				compaction,
			});
			const output: string[] = [];
			const exitCode = await runCodingPrintMode(runtime, {
				mode: "text",
				initialMessage: "hello",
				write: (text) => output.push(text),
			});
			const expectedMessages = structuredClone(runtime.driver.messages);
			expect(exitCode).toBe(0);
			expect(output.join("")).toBe("canonical output\n");

			restored = await createCodingRuntime({
				cwd,
				sessionsRoot,
				sessionId: "print-mode",
				streamFn: () => {
					throw new Error("restoration must not call the model");
				},
				toolNames: [],
				includeDefaultSkills: false,
				compaction,
			});
			expect(restored.driver.messages).toEqual(expectedMessages);
		} finally {
			await restored?.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("emits a machine-readable session header and agent events", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-print-json-"));
		try {
			const runtime = await createCodingRuntime({
				cwd,
				sessionsRoot: join(cwd, ".sessions"),
				sessionId: "print-json",
				streamFn,
				toolNames: [],
				includeDefaultSkills: false,
				compaction,
			});
			const output: string[] = [];
			const exitCode = await runCodingPrintMode(runtime, {
				mode: "json",
				initialMessage: "hello",
				write: (text) => output.push(text),
			});
			const events = output
				.join("")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { type?: string; snapshot?: { recovery?: { status?: string } } });
			expect(exitCode).toBe(0);
			expect(events[0]).toMatchObject({ type: "session", profileId: "coding" });
			expect(events.some((event) => event.type === "agent_start")).toBe(true);
			expect(events.some((event) => event.type === "agent_end")).toBe(true);
			const snapshots = events.filter((event) => event.type === "runtime_snapshot");
			expect(snapshots.length).toBeGreaterThanOrEqual(2);
			expect(snapshots.at(-1)?.snapshot?.recovery?.status).toBe("idle");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("passes an image-bearing initial Agent message through the canonical Driver", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-print-image-"));
		let sawImage = false;
		const imageStream: StreamFn = (_model, context) => {
			sawImage = context.messages.some(
				(message) =>
					message.role === "user" &&
					typeof message.content !== "string" &&
					message.content.some((part) => part.type === "image" && part.data === "aGVsbG8="),
			);
			return streamFn(_model, context);
		};
		try {
			const runtime = await createCodingRuntime({
				cwd,
				sessionsRoot: join(cwd, ".sessions"),
				sessionId: "print-image",
				streamFn: imageStream,
				toolNames: [],
				includeDefaultSkills: false,
				compaction,
			});
			const exitCode = await runCodingPrintMode(runtime, {
				mode: "text",
				initialInput: {
					role: "user",
					content: [
						{ type: "text", text: "inspect" },
						{ type: "image", mimeType: "image/png", data: "aGVsbG8=" },
					],
					timestamp: Date.now(),
				},
				write: () => undefined,
			});
			expect(exitCode).toBe(0);
			expect(sawImage).toBe(true);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("runs disambiguated legacy commands without invoking the model", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-print-command-"));
		const first = vi.fn();
		const second = vi.fn();
		try {
			const runtime = await createCodingRuntime({
				cwd,
				sessionsRoot: join(cwd, ".sessions"),
				sessionId: "print-command",
				streamFn: () => {
					throw new Error("extension command must not invoke the model");
				},
				toolNames: [],
				includeDefaultSkills: false,
				compaction,
				legacyExtensions: [
					{ factory: (api) => api.registerCommand("inspect", { handler: first }) },
					{ factory: (api) => api.registerCommand("inspect", { handler: second }) },
				],
				legacyExtensionCommandContext: () => ({ cwd }) as ExtensionCommandContext,
			});
			expect(runtime.legacyCommands.map((command) => command.invocationName)).toEqual(["inspect:1", "inspect:2"]);
			const exitCode = await runCodingPrintMode(runtime, { mode: "text", initialMessage: "/inspect:2 target" });
			expect(exitCode).toBe(0);
			expect(first).not.toHaveBeenCalled();
			expect(second).toHaveBeenCalledWith("target", expect.objectContaining({ cwd }));
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("runs a Harness-backed Extension command and flushes its durable runtime actions", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-print-command-context-"));
		let runtime: Awaited<ReturnType<typeof createCodingRuntime>> | undefined;
		const observed: string[] = [];
		try {
			const contexts = createHarnessExtensionContexts({
				cwd,
				mode: "print",
				modelRegistry: undefined as unknown as ModelRegistry,
				systemPromptOptions: { cwd },
				getRuntime: () => {
					if (!runtime) throw new Error("runtime not ready");
					return {
						driver: runtime.driver,
						sessionId: runtime.sessionId,
						sessionPath: runtime.sessionPath,
						getSessionName: () => runtime!.legacyExtensionSet.runtime.getSessionName(),
					};
				},
			});
			runtime = await createCodingRuntime({
				cwd,
				sessionsRoot: join(cwd, ".sessions"),
				sessionId: "command-context",
				streamFn: () => {
					throw new Error("extension command must not invoke the model");
				},
				toolNames: [],
				includeDefaultSkills: false,
				compaction,
				legacyExtensionContext: contexts.context,
				legacyExtensionCommandContext: contexts.commandContext,
				legacyExtensionFlagValues: new Map<string, boolean | string>([
					["safe", true],
					["label", "selected"],
				]),
				legacyExtensions: [
					{
						extensionPath: "<command-context>",
						factory: (api) => {
							api.registerFlag("safe", { type: "boolean" });
							api.registerFlag("label", { type: "string" });
							api.registerCommand("inspect", {
								async handler(args, context) {
									observed.push(
										args,
										context.cwd,
										context.sessionManager.getSessionId(),
										context.getSystemPrompt(),
										String(api.getFlag("safe")),
										String(api.getFlag("label")),
									);
									api.appendEntry("command-state", { args });
									api.setSessionName("Command session");
								},
							});
						},
					},
				],
			});

			const exitCode = await runCodingPrintMode(runtime, {
				mode: "text",
				initialMessage: "/inspect target",
			});

			expect(exitCode).toBe(0);
			expect(observed).toEqual(["target", cwd, "command-context", expect.any(String), "true", "selected"]);
			expect(await runtime.session.getName()).toBe("Command session");
			expect(await runtime.session.findEntries({ type: "custom", customType: "command-state" })).toHaveLength(1);
		} finally {
			await runtime?.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("bridges observational events and transforms message_end before commit", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-print-events-"));
		const agentStarts = vi.fn();
		const beforeAgentStart = vi.fn();
		const messageEnds = vi.fn();
		let runtime: Awaited<ReturnType<typeof createCodingRuntime>> | undefined;
		try {
			runtime = await createCodingRuntime({
				cwd,
				sessionsRoot: join(cwd, ".sessions"),
				sessionId: "print-events",
				streamFn,
				toolNames: [],
				includeDefaultSkills: false,
				compaction,
				legacyExtensions: [
					{
						extensionPath: "<events>",
						factory: (api) => {
							api.on("before_agent_start", async (event) => {
								beforeAgentStart(event);
								return {
									systemPrompt: `${event.systemPrompt}\nExtension instruction`,
									message: { customType: "extension-context", content: "injected context", display: true },
								};
							});
							api.on("agent_start", agentStarts);
							api.on("turn_start", async () => {
								throw new Error("isolated event failure");
							});
							api.on("message_end", async (event) => {
								messageEnds(event);
								return event.message.role === "assistant"
									? {
											message: {
												...event.message,
												content: [{ type: "text", text: "extension transformed" }],
											},
										}
									: undefined;
							});
						},
					},
				],
				legacyExtensionContext: () => ({ cwd }) as ExtensionContext,
			});
			await runtime.driver.prompt("hello");
			expect(beforeAgentStart).toHaveBeenCalledOnce();
			expect(agentStarts).toHaveBeenCalledOnce();
			expect(messageEnds).toHaveBeenCalled();
			expect(JSON.stringify(runtime.driver.messages.at(-1))).toContain("extension transformed");
			const persisted = await runtime.session.findEntries({ type: "message", order: "oldestFirst" });
			expect(JSON.stringify(persisted)).toContain("injected context");
			expect(JSON.stringify(persisted.at(-1))).toContain("extension transformed");
			const [operation] = await runtime.session.findRecords({ type: "operation_started" });
			if (operation?.intent.kind !== "run") throw new Error("Expected run operation");
			expect(operation.intent.initialMessages).toHaveLength(2);
			expect(operation.intent.systemPromptOverride).toContain("Extension instruction");
			expect(runtime.legacyExtensionErrors).toEqual([
				expect.objectContaining({
					extensionPath: "<events>",
					event: "turn_start",
					error: "isolated event failure",
				}),
			]);
		} finally {
			await runtime?.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
