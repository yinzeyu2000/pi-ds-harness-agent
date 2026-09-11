import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, CompactionPreparation, StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createCodingRuntime } from "../src/core/coding-runtime.ts";
import { CodingRuntimeController } from "../src/core/coding-runtime-controller.ts";

function textOf(message: AgentMessage | undefined): string {
	if (message?.role !== "user") return "";
	return typeof message.content === "string"
		? message.content
		: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

describe("Coding Runtime consumer controller", () => {
	it("routes auto delivery through one Driver and exposes the durable final snapshot", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-runtime-controller-"));
		let releaseFirst = () => {};
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let markStarted = () => {};
		const firstStarted = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const requested: string[] = [];
		let requestCount = 0;
		const streamFn: StreamFn = (_model, context) => {
			requested.push(textOf(context.messages.at(-1)));
			const current = ++requestCount;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				void (async () => {
					if (current === 1) {
						markStarted();
						await firstBlocked;
					}
					stream.push({
						type: "done",
						reason: "stop",
						message: {
							role: "assistant",
							content: [{ type: "text", text: `response ${current}` }],
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
				})();
			});
			return stream;
		};
		const runtime = await createCodingRuntime({
			cwd,
			sessionsRoot: join(cwd, ".sessions"),
			sessionId: "controller",
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
		const controller = await CodingRuntimeController.create(runtime);
		let agentEnds = 0;
		controller.onAgentEvent((event) => {
			if (event.type === "agent_end") agentEnds++;
		});

		const first = controller.send("initial");
		await firstStarted;
		await controller.send("queued");
		releaseFirst();
		await first;
		await controller.projection.settle();

		expect(requested).toEqual(["initial", "queued"]);
		expect(agentEnds).toBe(1);
		expect(controller.snapshot.projection.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(controller.snapshot.recovery).toEqual({ status: "idle" });
		const tree = await controller.getTree();
		const firstAssistant = tree.entries.find(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		expect(firstAssistant).toBeDefined();
		await controller.navigateTo(firstAssistant!.id);
		expect(controller.snapshot.projection.turnState.leafId).toBe(firstAssistant!.id);
		expect(controller.snapshot.projection.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		await controller.send("branched");
		expect(requested).toEqual(["initial", "queued", "branched"]);
		expect(JSON.stringify(controller.snapshot.projection.messages)).not.toContain("queued");
		const forkedMetadata = await controller.forkSession({ id: "controller-fork" });
		const expectedForkMessages = structuredClone(controller.snapshot.projection.messages);
		expect(forkedMetadata).toMatchObject({ id: "controller-fork", parentSessionId: "controller" });
		await controller.dispose();
		expect(() => controller.send("after dispose")).toThrow("disposed");
		const forked = await createCodingRuntime({
			cwd,
			sessionsRoot: join(cwd, ".sessions"),
			sessionId: "controller-fork",
			streamFn: () => {
				throw new Error("opening a fork must not invoke the model");
			},
			toolNames: [],
			includeDefaultSkills: false,
			compaction: {
				settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 0 },
				execute: async () => {
					throw new Error("not used");
				},
			},
		});
		expect(forked.driver.messages).toEqual(expectedForkMessages);
		await forked.dispose();
		await rm(cwd, { recursive: true, force: true });
	});
});
