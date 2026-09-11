import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CompactionPreparation, InMemoryTelemetryContext, type StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createCodingRuntime } from "../src/core/coding-runtime.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.ts";

const compaction = {
	settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 0 },
	execute: async (preparation: CompactionPreparation) => ({
		summary: "durable compacted history",
		tokensBefore: preparation.tokensBefore,
		retainedTail: preparation.retainedTail,
		details: { source: "test" },
		usage: {
			input: 3,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 5,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	}),
};

function assistantMessage(content: AssistantMessage["content"], stopReason: "stop" | "toolUse"): AssistantMessage {
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

describe("Coding Profile runtime", () => {
	it("anchors initial and Extension-mutated thinking/tool configuration in the next run", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-runtime-dynamic-config-"));
		let legacyApi: ExtensionAPI | undefined;
		let runtime: Awaited<ReturnType<typeof createCodingRuntime>> | undefined;
		try {
			runtime = await createCodingRuntime({
				cwd,
				sessionsRoot: join(cwd, ".sessions"),
				sessionId: "dynamic-config",
				streamFn: () => {
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() =>
						stream.push({
							type: "done",
							reason: "stop",
							message: assistantMessage([{ type: "text", text: "configured" }], "stop"),
						}),
					);
					return stream;
				},
				thinkingLevel: "low",
				toolNames: ["read"],
				includeDefaultSkills: false,
				compaction,
				legacyExtensions: [
					{
						factory: (api) => {
							legacyApi = api;
						},
					},
				],
			});

			expect(runtime.driver.thinkingLevel).toBe("low");
			expect(legacyApi?.getThinkingLevel()).toBe("low");
			expect(legacyApi?.getAllTools().map((tool) => tool.name)).toContain("read");
			legacyApi?.setThinkingLevel("high");
			legacyApi?.setActiveTools([]);
			expect(runtime.toolNames).toEqual([]);
			expect(() => legacyApi?.setActiveTools(["missing"])).toThrow("Unknown active Tool(s): missing");
			await runtime.driver.prompt("capture configuration");

			const anchors = await runtime.session.findEntries({
				type: "custom",
				customType: "pi-ds.request-configuration",
			});
			expect(anchors.at(-1)).toMatchObject({
				data: { schemaVersion: 1, thinkingLevel: "high", tools: [] },
			});
		} finally {
			await runtime?.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects unknown Extension CLI flags and disposes the activated scope", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-extension-flags-"));
		let capturedApi: ExtensionAPI | undefined;
		try {
			await expect(
				createCodingRuntime({
					cwd,
					sessionsRoot: join(cwd, ".sessions"),
					sessionId: "invalid-flags",
					streamFn: () => {
						throw new Error("not used");
					},
					toolNames: [],
					includeDefaultSkills: false,
					compaction,
					legacyExtensionFlagValues: new Map([["unknown", true]]),
					legacyExtensions: [
						{
							factory: (api) => {
								capturedApi = api;
								api.registerFlag("known", { type: "boolean" });
							},
						},
					],
				}),
			).rejects.toThrow("Unknown option: --unknown");
			expect(() => capturedApi?.getFlag("known")).toThrow("Plugin Scope was disposed");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("excludes default project Skills when the project is untrusted", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ds-coding-trust-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		let runtime: Awaited<ReturnType<typeof createCodingRuntime>> | undefined;
		try {
			await mkdir(join(cwd, ".pi", "skills", "project-skill"), { recursive: true });
			await mkdir(join(agentDir, "skills", "global-skill"), { recursive: true });
			await writeFile(
				join(cwd, ".pi", "skills", "project-skill", "SKILL.md"),
				"---\nname: project-skill\ndescription: project\n---\nproject\n",
				"utf8",
			);
			await writeFile(
				join(agentDir, "skills", "global-skill", "SKILL.md"),
				"---\nname: global-skill\ndescription: global\n---\nglobal\n",
				"utf8",
			);
			runtime = await createCodingRuntime({
				cwd,
				agentDir,
				sessionsRoot: join(root, ".sessions"),
				sessionId: "untrusted-skills",
				streamFn: () => {
					throw new Error("not used");
				},
				toolNames: [],
				includeDefaultSkills: true,
				projectTrusted: false,
				compaction,
			});

			expect(runtime.skills.map((skill) => skill.name)).toEqual(["global-skill"]);
		} finally {
			await runtime?.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("runs a real Pi read tool on one JSONL-backed Session and restores it", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-coding-runtime-"));
		const sessionsRoot = join(cwd, ".sessions");
		const skillDir = join(cwd, "skills", "sample-skill");
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(cwd, "sample.txt"), "durable coding runtime", "utf8");
		await writeFile(
			join(skillDir, "SKILL.md"),
			"---\nname: sample-skill\ndescription: Inspect sample runtime files.\n---\nUse the read tool.\n",
			"utf8",
		);
		let requestCount = 0;
		const systemPrompts: string[] = [];
		const telemetry = new InMemoryTelemetryContext();
		const streamFn: StreamFn = (_model, context) => {
			systemPrompts.push(context.systemPrompt ?? "");
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message =
					requestCount++ === 0
						? assistantMessage([fauxToolCall("read", { path: "sample.txt" })], "toolUse")
						: assistantMessage([{ type: "text", text: "read complete" }], "stop");
				stream.push({
					type: "done",
					reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
					message,
				});
			});
			return stream;
		};
		let first: Awaited<ReturnType<typeof createCodingRuntime>> | undefined;
		let second: Awaited<ReturnType<typeof createCodingRuntime>> | undefined;
		let sessionPath = "";
		let restoredSkills: Awaited<ReturnType<typeof createCodingRuntime>>["skills"] = [];
		let legacyApi: ExtensionAPI | undefined;
		try {
			first = await createCodingRuntime({
				cwd,
				sessionsRoot,
				sessionId: "coding-runtime",
				streamFn,
				toolNames: ["read"],
				skillPaths: [skillDir],
				includeDefaultSkills: false,
				compaction,
				telemetry,
				legacyExtensions: [
					{
						extensionPath: "<coding-runtime-extension>",
						factory: (api) => {
							legacyApi = api;
							api.registerCommand("runtime-command", { handler: async () => {} });
						},
					},
				],
			});
			expect(first.profile.id).toBe("coding");
			expect(first.toolNames).toEqual(["read"]);
			expect(first.skills.map((skill) => skill.name)).toEqual(["sample-skill"]);
			expect(first.resourceDiagnostics).toEqual([]);
			expect(first.legacyExtensionSet.extensions).toHaveLength(1);
			expect(first.legacyExtensionSet.extensions[0]?.commands.has("runtime-command")).toBe(true);
			await first.driver.prompt("Read sample.txt");
			expect(systemPrompts[0]).toContain("<name>sample-skill</name>");

			const originalMessages = structuredClone(first.driver.messages);
			const toolResults = originalMessages.filter((message) => message.role === "toolResult");
			expect(toolResults).toHaveLength(1);
			expect(JSON.stringify(toolResults[0])).toContain("durable coding runtime");
			const [toolStarted] = await first.session.findRecords({ type: "tool_started" });
			expect(toolStarted).toMatchObject({ toolName: "read", replay: "safe" });
			expect(await first.session.findRecords({ type: "operation_finished" })).toHaveLength(1);
			legacyApi?.sendMessage({
				customType: "runtime-note",
				content: "extension runtime action",
				display: true,
			});
			legacyApi?.appendEntry("runtime-state", { enabled: true });
			legacyApi?.setSessionName("Harness session");
			await first.flushLegacyActions();
			expect(legacyApi?.getSessionName()).toBe("Harness session");
			expect(legacyApi?.getActiveTools()).toEqual(["read"]);
			expect(JSON.stringify(first.driver.messages)).toContain("extension runtime action");
			expect(await first.session.getName()).toBe("Harness session");
			expect(await first.session.findEntries({ type: "custom", customType: "runtime-state" })).toHaveLength(1);
			const compacted = await first.driver.compact();
			expect(compacted).toMatchObject({ type: "compaction", summary: "durable compacted history" });
			const compactedMessages = structuredClone(first.driver.messages);
			expect(JSON.stringify(compactedMessages)).toContain("durable compacted history");
			const compactionUsage = await first.session.findRecords({ type: "usage" });
			expect(compactionUsage.some((record) => record.cause === "compaction")).toBe(true);
			expect(await first.session.findRecords({ type: "operation_finished" })).toHaveLength(2);
			const spans = telemetry.getSpans();
			const runSpan = spans.find((span) => span.name === "pi.harness.run");
			const toolSpan = spans.find((span) => span.name === "pi.harness.tool");
			expect(runSpan).toMatchObject({
				attributes: { "pi.operation.kind": "run", "pi.operation.recovery": false },
				status: { status: "ok" },
				settled: true,
			});
			expect(toolSpan).toMatchObject({
				parentId: runSpan?.id,
				attributes: {
					"pi.tool.name": "read",
					"pi.tool.replay": "safe",
					"pi.tool.recovery": false,
					"pi.tool.is_error": false,
				},
			});
			expect(spans.find((span) => span.name === "pi.harness.compaction")).toMatchObject({
				attributes: { "pi.operation.kind": "compaction", "pi.operation.outcome": "completed" },
				settled: true,
			});
			expect(await readFile(first.sessionPath, "utf8")).toContain('"kind":"header"');
			sessionPath = first.sessionPath;
			restoredSkills = first.skills;
			await first.dispose();
			first = undefined;
			expect(() => legacyApi?.registerCommand("stale", { handler: async () => {} })).toThrow(
				"Plugin Scope was disposed",
			);

			second = await createCodingRuntime({
				cwd,
				sessionsRoot,
				sessionId: "coding-runtime",
				streamFn: () => {
					throw new Error("resume must not invoke the model");
				},
				toolNames: ["read"],
				skills: restoredSkills,
				includeDefaultSkills: false,
				compaction,
			});
			expect(second.driver.messages).toEqual(compactedMessages);
			expect(second.sessionPath).toBe(sessionPath);
			expect(second.legacyExtensionSet.extensions).toEqual([]);
			expect(await second.session.findRecords({ type: "operation_finished" })).toHaveLength(2);
		} finally {
			await first?.dispose();
			await second?.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("denies side-effect tools by default and delegates an explicit allow decision", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-coding-approval-"));
		const sessionsRoot = join(cwd, ".sessions");
		const deniedPath = join(cwd, "denied.txt");
		const allowedPath = join(cwd, "allowed.txt");
		const approvals: string[] = [];
		let denied: Awaited<ReturnType<typeof createCodingRuntime>> | undefined;
		let allowed: Awaited<ReturnType<typeof createCodingRuntime>> | undefined;
		try {
			denied = await createCodingRuntime({
				cwd,
				sessionsRoot,
				sessionId: "approval-denied",
				streamFn: toolCallingStream("denied.txt", "must not exist"),
				toolNames: ["write"],
				includeDefaultSkills: false,
				compaction,
			});
			await denied.driver.prompt("Write a denied file");
			await expect(readFile(deniedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			const deniedResult = denied.driver.messages.find((message) => message.role === "toolResult");
			expect(deniedResult).toMatchObject({ role: "toolResult", isError: true });
			expect(JSON.stringify(deniedResult)).toContain("no interactive approval service");

			allowed = await createCodingRuntime({
				cwd,
				sessionsRoot,
				sessionId: "approval-allowed",
				streamFn: toolCallingStream("allowed.txt", "approved content"),
				toolNames: ["write"],
				includeDefaultSkills: false,
				compaction,
				approval: {
					requestApproval(request) {
						approvals.push(request.name);
						return { decision: "allow" };
					},
				},
			});
			await allowed.driver.prompt("Write an approved file");
			expect(await readFile(allowedPath, "utf8")).toBe("approved content");
			expect(approvals).toEqual(["write"]);
			const [started] = await allowed.session.findRecords({ type: "tool_started" });
			expect(started).toMatchObject({ toolName: "write", replay: "never" });
		} finally {
			await denied?.dispose();
			await allowed?.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("binds an approved Extension tool into the prompt, driver, and durable session", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-extension-tool-"));
		const sessionsRoot = join(cwd, ".sessions");
		const approvals: string[] = [];
		const systemPrompts: string[] = [];
		let requestCount = 0;
		let observedCwd = "";
		let observedValue = "";
		let runtime: Awaited<ReturnType<typeof createCodingRuntime>> | undefined;
		try {
			runtime = await createCodingRuntime({
				cwd,
				sessionsRoot,
				sessionId: "extension-tool",
				toolNames: ["read"],
				includeDefaultSkills: false,
				compaction,
				approval: {
					requestApproval(request) {
						approvals.push(request.name);
						return { decision: "allow" };
					},
				},
				legacyExtensionContext: () => ({ cwd }) as ExtensionContext,
				legacyExtensions: [
					{
						extensionPath: "<extension-tool>",
						factory: (api) => {
							api.on("tool_call", async (event) => {
								if (event.toolName === "extension_echo") event.input.value = "rewritten";
							});
							api.on("tool_result", async (event) =>
								event.toolName === "extension_echo"
									? {
											content: [{ type: "text", text: `hooked:${JSON.stringify(event.content)}` }],
											details: { transformed: true },
										}
									: undefined,
							);
							api.registerTool({
								name: "extension_echo",
								label: "Extension Echo",
								description: "Echo a value through an Extension tool",
								promptSnippet: "Echo a value from a legacy Extension",
								promptGuidelines: ["Use extension_echo for Extension binding checks"],
								parameters: Type.Object({ value: Type.String() }),
								async execute(_toolCallId, { value }, _signal, _onUpdate, context) {
									observedCwd = context.cwd;
									observedValue = value;
									return { content: [{ type: "text", text: `extension:${value}` }], details: {} };
								},
							});
						},
					},
				],
				streamFn: (_model, context) => {
					systemPrompts.push(context.systemPrompt ?? "");
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => {
						const message =
							requestCount++ === 0
								? assistantMessage([fauxToolCall("extension_echo", { value: "bound" })], "toolUse")
								: assistantMessage([{ type: "text", text: "extension complete" }], "stop");
						stream.push({
							type: "done",
							reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
							message,
						});
					});
					return stream;
				},
			});
			expect(runtime.toolNames).toEqual(["read", "extension_echo"]);
			await runtime.driver.prompt("Use the Extension tool");
			expect(approvals).toEqual(["extension_echo"]);
			expect(observedCwd).toBe(cwd);
			expect(observedValue).toBe("rewritten");
			expect(systemPrompts[0]).toContain("extension_echo: Echo a value from a legacy Extension");
			expect(systemPrompts[0]).toContain("Use extension_echo for Extension binding checks");
			expect(JSON.stringify(runtime.driver.messages)).toContain("hooked:");
			expect(JSON.stringify(runtime.driver.messages)).toContain("extension:rewritten");
			const [started] = await runtime.session.findRecords({ type: "tool_started" });
			expect(started).toMatchObject({
				toolName: "extension_echo",
				replay: "never",
				effectiveArgs: { value: "rewritten" },
			});
			const durableResults = await runtime.session.findEntries({ type: "message", order: "oldestFirst" });
			expect(
				JSON.stringify(
					durableResults.find((entry) => entry.type === "message" && entry.message.role === "toolResult"),
				),
			).toContain("extension:rewritten");
		} finally {
			await runtime?.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("lets a legacy Extension block a tool before execution and durable tool start", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-extension-block-"));
		const executeCalls: string[] = [];
		let runtime: Awaited<ReturnType<typeof createCodingRuntime>> | undefined;
		try {
			runtime = await createCodingRuntime({
				cwd,
				sessionsRoot: join(cwd, ".sessions"),
				sessionId: "extension-block",
				toolNames: [],
				includeDefaultSkills: false,
				compaction,
				approval: { requestApproval: () => ({ decision: "allow" }) },
				legacyExtensionContext: () => ({ cwd }) as ExtensionContext,
				legacyExtensions: [
					{
						extensionPath: "<extension-block>",
						factory: (api) => {
							api.on("tool_call", async (event) =>
								event.toolName === "extension_blocked"
									? { block: true, reason: "blocked by extension policy", terminate: true }
									: undefined,
							);
							api.registerTool({
								name: "extension_blocked",
								label: "Blocked Extension Tool",
								description: "Must not execute",
								parameters: Type.Object({ value: Type.String() }),
								async execute(_toolCallId, { value }) {
									executeCalls.push(value);
									return { content: [{ type: "text", text: value }], details: {} };
								},
							});
						},
					},
				],
				streamFn: () => {
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => {
						const message = assistantMessage(
							[fauxToolCall("extension_blocked", { value: "must-not-run" })],
							"toolUse",
						);
						stream.push({ type: "done", reason: "toolUse", message });
					});
					return stream;
				},
			});

			await runtime.driver.prompt("Try the blocked tool");

			expect(executeCalls).toEqual([]);
			expect(await runtime.session.findRecords({ type: "tool_started" })).toEqual([]);
			const blockedResult = runtime.driver.messages.find((message) => message.role === "toolResult");
			expect(blockedResult).toMatchObject({ role: "toolResult", isError: true });
			expect(JSON.stringify(blockedResult)).toContain("blocked by extension policy");
		} finally {
			await runtime?.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

function toolCallingStream(path: string, content: string): StreamFn {
	let requestCount = 0;
	return () => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message =
				requestCount++ === 0
					? assistantMessage([fauxToolCall("write", { path, content })], "toolUse")
					: assistantMessage([{ type: "text", text: "write complete" }], "stop");
			stream.push({
				type: "done",
				reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
				message,
			});
		});
		return stream;
	};
}
