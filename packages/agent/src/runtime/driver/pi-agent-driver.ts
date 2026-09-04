import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@earendil-works/pi-ai";
import { asStepId, asToolAttemptId, asToolCallId, type WireEventEnvelope } from "@earendil-works/pi-protocol";
import { runAgentLoop } from "../../agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool, StreamFn } from "../../types.ts";
import type { AgentDriver, DriverRunOptions, DriverRunResult } from "../types/agent-driver.ts";
import type { ExecutionBroker } from "../types/execution-broker.ts";
import type { JournalWriter } from "../types/journal.ts";
import type { ModelGateway } from "../types/model-gateway.ts";
import { PiEventTranslator } from "./pi-event-translator.ts";

export interface PiAgentDriverOptions {
	readonly modelGateway: ModelGateway;
	readonly executionBroker: ExecutionBroker;
	readonly journalWriter: JournalWriter;
	readonly onWireEvent?: (event: WireEventEnvelope) => void;
	readonly model?: Model<any>;
	readonly tools?: readonly AgentTool[];
}

export class PiAgentDriver implements AgentDriver {
	readonly name = "PiAgentDriver";
	private readonly modelGateway: ModelGateway;
	private readonly executionBroker: ExecutionBroker;
	private readonly journalWriter: JournalWriter;
	private readonly onWireEvent?: (event: WireEventEnvelope) => void;
	private readonly model: Model<any>;
	private readonly tools: readonly AgentTool[];

	constructor(options: PiAgentDriverOptions) {
		this.modelGateway = options.modelGateway;
		this.executionBroker = options.executionBroker;
		this.journalWriter = options.journalWriter;
		this.onWireEvent = options.onWireEvent;
		this.model =
			options.model ??
			({
				id: "default-model",
				name: "Default Model",
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 1024,
			} as unknown as Model<any>);
		this.tools = options.tools ?? [];
	}

	async run(options: DriverRunOptions): Promise<DriverRunResult> {
		const translator = new PiEventTranslator(options.threadId, options.turnId);
		let stepIndex = 0;

		// Broker wrapper around tools
		const brokerWrappedTools: AgentTool[] = this.tools.map((tool) => {
			return {
				name: tool.name,
				label: tool.label ?? tool.name,
				description: tool.description,
				parameters: tool.parameters,
				execute: async (toolCallId: string, params: any, signal?: AbortSignal) => {
					const toolAttemptId = asToolAttemptId(`att_${toolCallId}`);
					const stepId = asStepId(`step_${options.turnId}_${stepIndex}`);

					const prepared = await this.executionBroker.prepareAction(tool.name, params, {
						toolAttemptId,
						toolCallId: asToolCallId(toolCallId),
						turnId: options.turnId,
						stepId,
						signal: signal ?? options.signal,
					});

					const outcome = await this.executionBroker.executeAction(prepared, {
						toolAttemptId,
						toolCallId: asToolCallId(toolCallId),
						turnId: options.turnId,
						stepId,
						signal: signal ?? options.signal,
					});

					if (outcome.status === "failed") {
						throw new Error(outcome.error ?? "Tool execution failed");
					}

					return {
						content: [
							{
								type: "text" as const,
								text: typeof outcome.output === "string" ? outcome.output : JSON.stringify(outcome.output),
							},
						],
						details: outcome.output,
					};
				},
			};
		});

		// ModelGateway-backed stream function
		const streamFn: StreamFn = async (_model, context) => {
			stepIndex++;
			const stepId = asStepId(`step_${options.turnId}_${stepIndex}`);
			const modelAttemptId = `mdl_att_${stepId}`;

			const stream = await this.modelGateway.stream(
				{
					model: this.model,
					messages: context.messages,
					systemPrompt: context.systemPrompt,
					tools: brokerWrappedTools,
					idempotencyKey: `${options.threadId}_${options.turnId}_${stepIndex}`,
				},
				{
					modelAttemptId,
					turnId: options.turnId,
					stepId,
					signal: options.signal,
					onDispatchIntentFlushed: async () => {
						// Pre-dispatch intent barrier
						await this.journalWriter.flush();
					},
				},
			);

			const eventStream = new EventStream<AssistantMessageEvent, AssistantMessage>(
				(ev) => ev.type === "done" || ev.type === "error",
				(ev) => {
					if (ev.type === "done") return ev.message;
					if (ev.type === "error") return ev.error as any;
					throw new Error("Stream ended unexpectedly");
				},
			);

			void (async () => {
				for await (const event of stream) {
					if (event.type === "started") {
						eventStream.push({
							type: "start",
							partial: {
								role: "assistant",
								content: [],
								api: this.model.api,
								provider: this.model.provider,
								model: this.model.id,
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
					} else if (event.type === "done" && event.message) {
						eventStream.push({
							type: "done",
							reason: (event.message.stopReason as any) ?? "stop",
							message: event.message,
						});
					} else if (event.type === "error") {
						eventStream.push({
							type: "error",
							reason: "error",
							error: {
								role: "assistant",
								content: [],
								api: this.model.api,
								provider: this.model.provider,
								model: this.model.id,
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 0,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
								stopReason: "error",
								errorMessage: event.error?.message ?? "Model call failed",
								timestamp: Date.now(),
							},
						});
					}
				}
			})();

			return eventStream;
		};

		const agentContext: AgentContext = {
			systemPrompt: "You are a helpful coding assistant.",
			messages: [],
			tools: brokerWrappedTools,
		};

		const agentConfig: AgentLoopConfig = {
			model: this.model,
			toolExecution: "sequential",
			convertToLlm: (msgs) =>
				msgs.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as any,
		};

		const promptMessages: AgentMessage[] = [
			{
				role: "user",
				content: typeof options.input === "string" ? options.input : JSON.stringify(options.input),
				timestamp: Date.now(),
			},
		];

		const eventSink = async (event: AgentEvent) => {
			const translated = translator.translate(event);
			if (translated.journalDrafts.length > 0) {
				await this.journalWriter.append(translated.journalDrafts);
				await this.journalWriter.persist();
			}
			if (translated.wireEvent && this.onWireEvent) {
				this.onWireEvent(translated.wireEvent);
			}
		};

		try {
			await runAgentLoop(promptMessages, agentContext, agentConfig, eventSink, options.signal, streamFn);

			return {
				turnId: options.turnId,
				outcome: options.signal.aborted ? "interrupted" : "completed",
			};
		} catch (error) {
			if (options.signal.aborted) {
				return {
					turnId: options.turnId,
					outcome: "interrupted",
					message: "Turn cancelled by signal",
				};
			}
			return {
				turnId: options.turnId,
				outcome: "failed",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}
}
