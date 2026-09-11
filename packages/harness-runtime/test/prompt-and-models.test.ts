import { InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type Models,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createMinimalRuntime } from "../src/minimal-runtime.ts";
import { HarnessModelNotFoundError, PiModelsProvider } from "../src/models-provider.ts";
import { PromptCatalog, PromptContributorConflictError } from "../src/prompt.ts";

function modelFixture(): Model<Api> {
	return {
		id: "faux-1",
		name: "Faux",
		api: "openai-completions",
		provider: "faux",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	};
}

function completedResponse(): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "openai-completions",
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
		};
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

describe("prompt contributors", () => {
	it("renders deterministically in priority order and unregisters by scope", async () => {
		const catalog = new PromptCatalog("base");
		catalog.register({ id: "late", priority: 10, contribute: () => "late" });
		const unregister = catalog.register({ id: "early", priority: -10, contribute: async () => "early" });
		expect(() => catalog.register({ id: "early", contribute: () => "duplicate" })).toThrow(
			PromptContributorConflictError,
		);
		expect(await catalog.render()).toEqual({
			text: "base\n\nearly\n\nlate",
			contributorIds: ["early", "late"],
		});
		unregister();
		expect((await catalog.render()).text).toBe("base\n\nlate");
	});
});

describe("Pi Models Provider", () => {
	it("resolves an exact model and delegates streaming", async () => {
		const model = modelFixture();
		const streamSimple = vi.fn(() => completedResponse());
		const models = {
			getModel: vi.fn((provider: string, id: string) =>
				provider === model.provider && id === model.id ? model : undefined,
			),
			streamSimple,
		} as unknown as Models;
		const provider = new PiModelsProvider(models);
		expect(provider.resolve({ provider: "faux", id: "faux-1" })).toBe(model);
		expect(() => provider.resolve({ provider: "faux", id: "missing" })).toThrow(HarnessModelNotFoundError);
		await provider.stream(model, { systemPrompt: "prompt", messages: [] });
		expect(streamSimple).toHaveBeenCalledWith(model, { systemPrompt: "prompt", messages: [] }, undefined);
	});

	it("builds a temporary prompt view and snapshots the selected model", async () => {
		const model = modelFixture();
		const contexts: string[] = [];
		const models = {
			getModel: () => model,
			streamSimple: (_model: Model<Api>, context: Context) => {
				contexts.push(context.systemPrompt ?? "");
				return completedResponse();
			},
		} as unknown as Models;
		const repo = new InMemorySessionRepo();
		const runtime = await createMinimalRuntime({
			models,
			modelSelection: { provider: "faux", id: "faux-1" },
			systemPrompt: "base",
			promptContributors: [
				{ id: "workspace", priority: 10, contribute: () => "workspace rules" },
				{ id: "safety", priority: -10, contribute: () => "safety rules" },
			],
			sessionRepo: repo,
		});
		await runtime.driver.prompt("hello");
		expect(contexts).toEqual(["base\n\nsafety rules\n\nworkspace rules"]);
		const messages = await runtime.session.findEntries({ type: "message" });
		expect(messages).toHaveLength(2);
		expect(messages.every((entry) => entry.type === "message")).toBe(true);
		const [configuration] = await runtime.session.findEntries({ type: "custom" });
		expect(configuration).toMatchObject({
			data: {
				systemPrompt: "base\n\nsafety rules\n\nworkspace rules",
				model: { provider: "faux", id: "faux-1" },
			},
		});
		await runtime.dispose();
	});
});
