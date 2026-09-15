import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createCodingRuntime } from "../src/core/coding-runtime.ts";
import { CodingRuntimeHost, type CodingRuntimeTarget } from "../src/core/coding-runtime-host.ts";
import { HarnessRpcSession } from "../src/modes/rpc/harness-rpc.ts";

describe("Coding Runtime Host", () => {
	it("disposes a replacement created after Host shutdown", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-runtime-host-dispose-race-"));
		const sessionsRoot = join(cwd, ".sessions");
		let releaseFactory: () => void = () => undefined;
		let notifyFactoryStarted: () => void = () => undefined;
		const factoryStarted = new Promise<void>((resolve) => {
			notifyFactoryStarted = resolve;
		});
		const factoryGate = new Promise<void>((resolve) => {
			releaseFactory = resolve;
		});
		const create = async (target: CodingRuntimeTarget) => {
			if (target.sessionId === "late") {
				notifyFactoryStarted();
				await factoryGate;
			}
			return createCodingRuntime({
				cwd: target.cwd,
				sessionsRoot,
				sessionId: target.sessionId,
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
		};
		let host: CodingRuntimeHost | undefined;
		try {
			host = await CodingRuntimeHost.create(await create({ sessionId: "source", cwd }), create);
			const replacement = host.switchSession({ sessionId: "late", cwd });
			await factoryStarted;
			await host.dispose();
			releaseFactory();
			await expect(replacement).rejects.toThrow("Coding Runtime Host is disposed");
			expect(() => host!.snapshot).toThrow("Coding Runtime Host is disposed");
			host = undefined;
		} finally {
			releaseFactory();
			await host?.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("switches hosted RPC across projects without creating missing targets", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-runtime-host-rpc-source-"));
		const otherCwd = await mkdtemp(join(tmpdir(), "pi-ds-runtime-host-rpc-target-"));
		const sessionsRoot = join(cwd, ".sessions");
		const create = (target: CodingRuntimeTarget) =>
			createCodingRuntime({
				cwd: target.cwd,
				sessionsRoot,
				sessionId: target.sessionId,
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
		let host: CodingRuntimeHost | undefined;
		try {
			const target = await create({ sessionId: "target", cwd: otherCwd });
			await target.dispose();
			host = await CodingRuntimeHost.create(await create({ sessionId: "source", cwd }), create);
			const sourcePath = host.snapshot.session.path;
			const rpc = await HarnessRpcSession.createHosted(host, () => undefined);
			expect(await rpc.handle({ type: "switch_session", sessionId: "target", cwd: otherCwd })).toMatchObject({
				success: true,
				data: { previousSessionId: "source", sessionId: "target" },
			});
			expect(host.snapshot.session).toMatchObject({ id: "target", cwd: otherCwd });
			expect(await rpc.handle({ type: "switch_session", sessionId: relative(otherCwd, sourcePath) })).toMatchObject({
				success: true,
				data: { previousSessionId: "target", sessionId: "source" },
			});
			expect(host.snapshot.session).toMatchObject({ id: "source", cwd });
			expect(await rpc.handle({ type: "switch_session", sessionId: "missing", cwd: otherCwd })).toMatchObject({
				success: false,
				error: "Harness session was not found: missing",
			});
			expect((await host.controller.listSessions("all")).some(({ id }) => id === "missing")).toBe(false);
			await rpc.dispose();
			host = undefined;
		} finally {
			await host?.dispose();
			await rm(cwd, { recursive: true, force: true });
			await rm(otherCwd, { recursive: true, force: true });
		}
	});

	it("serializes concurrent Runtime replacement attempts", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-runtime-host-concurrency-"));
		const sessionsRoot = join(cwd, ".sessions");
		let releaseFactory: () => void = () => undefined;
		let notifyFactoryStarted: () => void = () => undefined;
		const factoryStarted = new Promise<void>((resolve) => {
			notifyFactoryStarted = resolve;
		});
		const factoryGate = new Promise<void>((resolve) => {
			releaseFactory = resolve;
		});
		const create = async (target: CodingRuntimeTarget) => {
			if (target.sessionId === "slow") {
				notifyFactoryStarted();
				await factoryGate;
			}
			return createCodingRuntime({
				cwd: target.cwd,
				sessionsRoot,
				sessionId: target.sessionId,
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
		};
		let host: CodingRuntimeHost | undefined;
		try {
			host = await CodingRuntimeHost.create(await create({ sessionId: "source", cwd }), create);
			const first = host.switchSession({ sessionId: "slow", cwd });
			await factoryStarted;
			await expect(host.switchSession({ sessionId: "second", cwd })).rejects.toThrow(
				"replacement is already in progress",
			);
			releaseFactory();
			await expect(first).resolves.toMatchObject({ previousSessionId: "source", sessionId: "slow" });
			expect(host.snapshot.session.id).toBe("slow");
		} finally {
			releaseFactory();
			await host?.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("forks, replaces the Runtime, and rebinds durable snapshot consumers", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-runtime-host-"));
		const sessionsRoot = join(cwd, ".sessions");
		let responseCount = 0;
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [{ type: "text", text: `host response ${++responseCount}` }],
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
		const create = (target: CodingRuntimeTarget) => {
			if (target.sessionId === "broken") return Promise.reject(new Error("replacement factory failed"));
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
			});
		};
		let host: CodingRuntimeHost | undefined;
		try {
			host = await CodingRuntimeHost.create(await create({ sessionId: "source", cwd }), create);
			const sessionIds: string[] = [];
			let agentEnds = 0;
			host.subscribe((snapshot) => {
				sessionIds.push(snapshot.session.id);
			});
			host.subscribe(() => {
				throw new Error("isolated host observer");
			});
			host.onAgentEvent((event) => {
				if (event.type === "agent_end") agentEnds++;
			});
			await host.controller.send("source prompt");
			await expect(host.switchSession({ sessionId: "broken", cwd })).rejects.toThrow("replacement factory failed");
			expect(host.snapshot.session.id).toBe("source");
			const oldController = host.controller;
			const { metadata, replacement } = await host.forkAndSwitch({ id: "forked" });

			expect(metadata).toMatchObject({ id: "forked", parentSessionId: "source" });
			expect(replacement).toMatchObject({ previousSessionId: "source", sessionId: "forked" });
			expect(host.snapshot.session.id).toBe("forked");
			expect(() => oldController.send("stale")).toThrow("disposed");
			await host.controller.send("fork prompt");
			expect(JSON.stringify(host.snapshot.projection.messages)).toContain("source prompt");
			expect(JSON.stringify(host.snapshot.projection.messages)).toContain("fork prompt");
			expect(sessionIds).toContain("source");
			expect(sessionIds).toContain("forked");
			expect(agentEnds).toBe(2);

			const rpc = await HarnessRpcSession.createHosted(host, () => undefined);
			expect(await rpc.handle({ type: "clone", sessionId: "rpc-clone" })).toMatchObject({
				success: true,
				data: {
					metadata: { id: "rpc-clone", parentSessionId: "forked" },
					replacement: { previousSessionId: "forked", sessionId: "rpc-clone" },
				},
			});
			expect(host.snapshot.session.id).toBe("rpc-clone");
			expect(JSON.stringify(host.snapshot.projection.messages)).toContain("fork prompt");
			expect(await rpc.handle({ type: "switch_session", sessionId: "source" })).toMatchObject({
				success: true,
				data: { previousSessionId: "rpc-clone", sessionId: "source" },
			});
			expect(host.snapshot.session.id).toBe("source");
			expect(JSON.stringify(host.snapshot.projection.messages)).not.toContain("fork prompt");
			expect(
				await rpc.handle({
					type: "new_session",
					sessionId: "rpc-new",
					parentSession: "source",
				}),
			).toMatchObject({ success: true, data: { previousSessionId: "source", sessionId: "rpc-new" } });
			expect(host.snapshot.session.id).toBe("rpc-new");
			expect((await host.controller.listSessions("all")).find(({ id }) => id === "rpc-new")?.parentSessionId).toBe(
				"source",
			);
			await rpc.dispose();
		} finally {
			await host?.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
