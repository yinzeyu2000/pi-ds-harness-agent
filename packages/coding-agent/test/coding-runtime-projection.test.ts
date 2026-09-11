import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createCodingRuntime } from "../src/core/coding-runtime.ts";
import { CodingRuntimeProjection } from "../src/core/coding-runtime-projection.ts";

const streamFn: StreamFn = () => {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() =>
		stream.push({
			type: "done",
			reason: "stop",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "projected" }],
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

describe("Coding Runtime durable projection", () => {
	it("publishes active and settled snapshots from the canonical Session", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-runtime-projection-"));
		const runtime = await createCodingRuntime({
			cwd,
			sessionsRoot: join(cwd, ".sessions"),
			sessionId: "projection",
			streamFn,
			toolNames: [],
			includeDefaultSkills: false,
			compaction: {
				settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 0 },
				execute: async () => {
					throw new Error("not used");
				},
			},
		});
		const projection = await CodingRuntimeProjection.create(runtime);
		const snapshots: Array<{ active: boolean; watermark: number; roles: string[] }> = [];
		projection.subscribe(() => {
			throw new Error("broken observer");
		});
		projection.subscribe((snapshot) => {
			snapshots.push({
				active: snapshot.projection.turnState.operation !== null,
				watermark: snapshot.projection.watermark,
				roles: snapshot.projection.messages.map((message) => message.role),
			});
		});

		await runtime.driver.prompt("hello");
		await projection.settle();
		await projection.refresh();

		const final = projection.snapshot;
		expect(snapshots.some((snapshot) => snapshot.active)).toBe(true);
		expect(snapshots.at(-1)?.active).toBe(false);
		expect(final.session).toMatchObject({ id: "projection", path: runtime.sessionPath });
		expect(final).toMatchObject({
			model: { provider: "unknown", id: "unknown", name: "unknown" },
			thinkingLevel: "off",
		});
		expect(final.projection.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(final.projection.messages).toEqual(runtime.driver.messages);
		expect(final.recovery).toEqual({ status: "idle" });
		expect(final.projection.watermark).toBeGreaterThan(0);

		const publishedCount = snapshots.length;
		projection.dispose();
		await runtime.driver.appendContextMessage({
			role: "custom",
			customType: "after-dispose",
			content: "ignored by disposed projection",
			display: true,
			timestamp: Date.now(),
		});
		expect(snapshots).toHaveLength(publishedCount);
		await runtime.dispose();
		await rm(cwd, { recursive: true, force: true });
	});
});
