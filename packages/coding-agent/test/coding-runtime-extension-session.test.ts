import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type CodingRuntime, createCodingRuntime } from "../src/core/coding-runtime.ts";
import { CodingRuntimeHost, type CodingRuntimeTarget } from "../src/core/coding-runtime-host.ts";
import { createHarnessExtensionContexts } from "../src/core/extensions/harness-context.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";

const streamFn: StreamFn = () => {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() =>
		stream.push({
			type: "done",
			reason: "stop",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "response" }],
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

describe("Coding Runtime Extension session operations", () => {
	it("rebinds withSession after new, switch, and fork, then safely reloads", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-extension-session-"));
		const sessionsRoot = join(cwd, ".sessions");
		let runtime: CodingRuntime | undefined;
		let host: CodingRuntimeHost | undefined;
		let forkEntryId: string | undefined;
		const getHost = () => {
			if (!host) throw new Error("host not ready");
			return host;
		};
		const resolveSession = async (reference: string) => {
			const matches = (await getHost().controller.listSessions("all")).filter(
				(metadata) => metadata.id === reference || resolve(metadata.path) === resolve(reference),
			);
			if (matches.length !== 1) throw new Error(`session resolution failed: ${reference}`);
			return matches[0]!;
		};
		const create = async (target: CodingRuntimeTarget) => {
			const contexts = createHarnessExtensionContexts({
				cwd: target.cwd,
				mode: "tui",
				modelRegistry: undefined as unknown as ModelRegistry,
				systemPromptOptions: { cwd: target.cwd },
				getRuntime: () => {
					if (host) {
						const snapshot = host.snapshot;
						return {
							driver: host.controller.driver,
							sessionId: snapshot.session.id,
							sessionPath: snapshot.session.path,
							getSessionName: () => snapshot.session.name,
						};
					}
					if (!runtime) throw new Error("runtime not ready");
					return {
						driver: runtime.driver,
						sessionId: runtime.sessionId,
						sessionPath: runtime.sessionPath,
						getSessionName: () => runtime!.legacyExtensionSet.runtime.getSessionName(),
					};
				},
				sessionOperations: {
					async newSession(parentSession) {
						const parentSessionId = parentSession ? (await resolveSession(parentSession)).id : undefined;
						await getHost().newSession({ cwd, parentSessionId });
					},
					async fork(entryId, position) {
						await getHost().forkAndSwitch({ entryId, position });
					},
					async switchSession(sessionPath) {
						const metadata = await resolveSession(sessionPath);
						await getHost().switchSession({ sessionId: metadata.id, cwd: metadata.cwd });
					},
					async reload() {
						await getHost().reload();
					},
				},
			});
			return createCodingRuntime({
				cwd: target.cwd,
				sessionsRoot,
				sessionId: target.sessionId,
				parentSessionId: target.parentSessionId,
				streamFn,
				toolNames: [],
				includeDefaultSkills: false,
				compaction: {
					settings: { enabled: false, reserveTokens: 100, keepRecentTokens: 0 },
					execute: async () => {
						throw new Error("not used");
					},
				},
				legacyExtensionContext: contexts.context,
				legacyExtensionCommandContext: contexts.commandContext,
				legacyExtensions: [
					{
						extensionPath: "<session-operations>",
						factory: (api) => {
							api.registerCommand("new-child", {
								async handler(_args, context) {
									await context.newSession({
										parentSession: "source",
										withSession: async (next) => {
											await next.sendMessage({ customType: "marker", content: "new", display: true });
										},
									});
								},
							});
							api.registerCommand("switch-source", {
								async handler(_args, context) {
									await context.switchSession("source", {
										withSession: async (next) => {
											await next.sendMessage({ customType: "marker", content: "switched", display: true });
										},
									});
								},
							});
							api.registerCommand("fork-source", {
								async handler(_args, context) {
									if (!forkEntryId) throw new Error("fork entry not ready");
									await context.fork(forkEntryId, {
										position: "at",
										withSession: async (next) => {
											await next.sendMessage({ customType: "marker", content: "forked", display: true });
										},
									});
								},
							});
							api.registerCommand("reload-runtime", {
								handler: async (_args, context) => context.reload(),
							});
						},
					},
				],
			});
		};

		try {
			runtime = await create({ sessionId: "source", cwd });
			host = await CodingRuntimeHost.create(runtime, create);
			await host.controller.send("seed");
			forkEntryId = (await host.controller.getTree()).entries.find(
				(entry) => entry.type === "message" && entry.message.role === "user",
			)?.id;

			await host.controller.invokeCommand("new-child");
			const childId = host.snapshot.session.id;
			expect(childId).not.toBe("source");
			expect((await host.controller.listSessions("all")).find(({ id }) => id === childId)?.parentSessionId).toBe(
				"source",
			);
			expect(JSON.stringify(host.controller.driver.messages)).toContain("new");

			await host.controller.invokeCommand("switch-source");
			expect(host.snapshot.session.id).toBe("source");
			expect(JSON.stringify(host.controller.driver.messages)).toContain("switched");

			await host.controller.invokeCommand("fork-source");
			const forkId = host.snapshot.session.id;
			expect(forkId).not.toBe("source");
			expect((await host.controller.listSessions("all")).find(({ id }) => id === forkId)?.parentSessionId).toBe(
				"source",
			);
			expect(JSON.stringify(host.controller.driver.messages)).toContain("forked");

			const staleController = host.controller;
			await staleController.invokeCommand("reload-runtime");
			expect(host.snapshot.session.id).toBe(forkId);
			expect(() => staleController.send("stale")).toThrow("disposed");
		} finally {
			await host?.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
