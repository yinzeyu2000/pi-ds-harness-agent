import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createCodingRuntime } from "../src/core/coding-runtime.ts";
import { CodingRuntimeHost } from "../src/core/coding-runtime-host.ts";
import { HarnessRpcSession } from "../src/modes/rpc/harness-rpc.ts";

describe("Coding Runtime Host", () => {
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
		const create = (sessionId: string) => {
			if (sessionId === "broken") return Promise.reject(new Error("replacement factory failed"));
			return createCodingRuntime({
				cwd,
				sessionsRoot,
				sessionId,
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
			host = await CodingRuntimeHost.create(await create("source"), create);
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
			await expect(host.switchSession("broken")).rejects.toThrow("replacement factory failed");
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
			expect(await rpc.handle({ type: "switch_session", sessionId: "source" })).toMatchObject({
				success: true,
				data: { previousSessionId: "forked", sessionId: "source" },
			});
			expect(host.snapshot.session.id).toBe("source");
			expect(JSON.stringify(host.snapshot.projection.messages)).not.toContain("fork prompt");
			await rpc.dispose();
		} finally {
			await host?.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
