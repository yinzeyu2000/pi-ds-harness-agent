import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { StepId, TurnId } from "@earendil-works/pi-protocol";

export interface FrozenModelRequest {
	readonly model: Model<any>;
	readonly messages: readonly unknown[];
	readonly systemPrompt?: string;
	readonly tools?: readonly unknown[];
	readonly options?: Record<string, unknown>;
	readonly idempotencyKey: string;
}

export interface ModelAttemptContext {
	readonly modelAttemptId: string;
	readonly turnId: TurnId;
	readonly stepId: StepId;
	readonly signal: AbortSignal;
	readonly onDispatchIntentFlushed?: () => Promise<void>;
}

export interface ModelGatewayStreamEvent {
	readonly type: "started" | "delta" | "done" | "error";
	readonly providerRequestId?: string;
	readonly delta?: string;
	readonly message?: AssistantMessage;
	readonly error?: Error;
}

export interface ModelEventStream {
	[Symbol.asyncIterator](): AsyncIterator<ModelGatewayStreamEvent>;
}

export interface ModelGateway {
	stream(request: FrozenModelRequest, context: ModelAttemptContext): Promise<ModelEventStream>;
}

export interface RuntimeModelAdapter {
	readonly gateway: ModelGateway;
	requestModel(request: FrozenModelRequest, context: ModelAttemptContext): Promise<AssistantMessage>;
}
