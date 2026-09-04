import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	FrozenModelRequest,
	ModelAttemptContext,
	ModelEventStream,
	ModelGateway,
	ModelGatewayStreamEvent,
	RuntimeModelAdapter,
} from "../types/model-gateway.ts";

export type FakeResponseGenerator = (
	request: FrozenModelRequest,
	attemptContext: ModelAttemptContext,
) => AssistantMessage;

export class FakeModelGateway implements ModelGateway {
	private readonly generator: FakeResponseGenerator;

	constructor(generator?: FakeResponseGenerator) {
		this.generator =
			generator ??
			((_request) => {
				return {
					role: "assistant",
					content: [{ type: "text", text: "Fake default assistant response" }],
					api: "openai-responses",
					provider: "openai",
					model: "fake-default-model",
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
			});
	}

	async stream(request: FrozenModelRequest, context: ModelAttemptContext): Promise<ModelEventStream> {
		// Pre-dispatch barrier: verify flush callback is called before generating stream
		if (context.onDispatchIntentFlushed) {
			await context.onDispatchIntentFlushed();
		}

		const message = this.generator(request, context);

		const events: ModelGatewayStreamEvent[] = [
			{ type: "started", providerRequestId: `req_${context.modelAttemptId}` },
			{ type: "done", message },
		];

		let index = 0;

		return {
			[Symbol.asyncIterator]() {
				return {
					async next(): Promise<IteratorResult<ModelGatewayStreamEvent>> {
						if (index < events.length) {
							return { value: events[index++]!, done: false };
						}
						return { value: undefined as any, done: true };
					},
				};
			},
		};
	}
}

export class RuntimeModelAdapterImpl implements RuntimeModelAdapter {
	readonly gateway: ModelGateway;

	constructor(gateway: ModelGateway) {
		this.gateway = gateway;
	}

	async requestModel(request: FrozenModelRequest, context: ModelAttemptContext): Promise<AssistantMessage> {
		const stream = await this.gateway.stream(request, context);
		let finalMessage: AssistantMessage | undefined;

		for await (const event of stream) {
			if (event.type === "done" && event.message) {
				finalMessage = event.message;
			}
		}

		if (!finalMessage) {
			throw new Error("Model stream ended without done event");
		}
		return finalMessage;
	}
}
