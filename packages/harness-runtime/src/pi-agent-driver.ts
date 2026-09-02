import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type Session,
	type StreamFn,
} from "@earendil-works/pi-agent-core";
import { type Model, uuidv7 } from "@earendil-works/pi-ai";
import { LiveEventBus } from "./events.ts";

export interface PiAgentDriverOptions {
	session: Session;
	streamFn: StreamFn;
	model?: Model<any>;
	systemPrompt?: string;
	tools?: AgentTool[];
}

export interface DriverEvents {
	"message/committed": { entryId: string; message: AgentMessage };
	"agent/event": AgentEvent;
}

export class PiAgentDriver {
	readonly events = new LiveEventBus<DriverEvents>();
	private readonly session: Session;
	private readonly agent: Agent;
	private readonly unsubscribe: () => void;
	private activeRunId?: string;
	private abortRequested = false;
	private abortRecordPromise?: Promise<void>;

	private constructor(session: Session, options: PiAgentDriverOptions, messages: AgentMessage[]) {
		this.session = session;
		this.agent = new Agent({
			streamFn: options.streamFn,
			initialState: {
				messages,
				model: options.model,
				systemPrompt: options.systemPrompt ?? "",
				tools: options.tools ?? [],
			},
		});
		this.unsubscribe = this.agent.subscribe((event) => this.handleAgentEvent(event));
	}

	static async create(options: PiAgentDriverOptions): Promise<PiAgentDriver> {
		const entries = await options.session.findEntries({ type: "message", order: "oldestFirst" });
		return new PiAgentDriver(
			options.session,
			options,
			entries.map((entry) => {
				if (entry.type !== "message") throw new Error("Session returned a non-message entry");
				return entry.message;
			}),
		);
	}

	async prompt(input: string): Promise<void> {
		if (this.activeRunId) throw new Error("Agent driver is already running");
		const runId = uuidv7();
		this.activeRunId = runId;
		this.abortRequested = false;
		this.abortRecordPromise = undefined;
		const message: AgentMessage = { role: "user", content: input, timestamp: Date.now() };
		await this.session.appendRecord({
			type: "operation_started",
			id: runId,
			lane: "main",
			sourceLeafId: await this.session.getLeafId(),
			intent: { kind: "run", originalPrompt: [message], initialMessages: [] },
		});
		let outcome: "completed" | "aborted" | "failed" = "completed";
		let failure: unknown;
		try {
			await this.agent.prompt(message);
			if (this.abortRequested) outcome = "aborted";
			else if (this.agent.state.errorMessage) {
				outcome = "failed";
				failure = new Error(this.agent.state.errorMessage);
			}
		} catch (error) {
			outcome = this.abortRequested ? "aborted" : "failed";
			failure = error;
		} finally {
			try {
				await this.abortRecordPromise;
			} catch (error) {
				failure ??= error;
				outcome = "failed";
			}
			const errorFact =
				failure === undefined
					? {}
					: {
							error: {
								code: "driver_error",
								message: failure instanceof Error ? failure.message : String(failure),
							},
						};
			try {
				await this.session.appendRecord({
					type: "operation_finished",
					id: uuidv7(),
					lane: "main",
					runId,
					outcome,
					...errorFact,
				});
			} finally {
				this.activeRunId = undefined;
				this.abortRecordPromise = undefined;
			}
		}
		if (failure !== undefined) throw failure;
	}

	abort(): void {
		if (!this.activeRunId) return;
		this.abortRequested = true;
		this.abortRecordPromise ??= this.session
			.appendRecord({
				type: "abort_requested",
				id: uuidv7(),
				lane: "main",
				runId: this.activeRunId,
			})
			.then(() => {});
		this.agent.abort();
	}

	waitForIdle(): Promise<void> {
		return this.agent.waitForIdle();
	}

	get messages(): readonly AgentMessage[] {
		return this.agent.state.messages;
	}

	async dispose(): Promise<void> {
		this.abort();
		await this.waitForIdle();
		this.unsubscribe();
		this.events.clear();
	}

	private async handleAgentEvent(event: AgentEvent): Promise<void> {
		if (event.type === "message_end") {
			const message = normalizeDurableMessage(event.message);
			const messages = this.agent.state.messages.slice();
			messages[messages.length - 1] = message;
			this.agent.state.messages = messages;
			const entryId = await this.session.appendMessage(message);
			await this.events.emit("message/committed", { entryId, message });
		}
		await this.events.emit("agent/event", event);
	}
}

function normalizeDurableMessage(message: AgentMessage): AgentMessage {
	return omitUndefinedProperties(message) as AgentMessage;
}

function omitUndefinedProperties(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => {
			if (item === undefined) throw new Error("Durable message contains undefined in an array");
			return omitUndefinedProperties(item);
		});
	}
	if (value === null || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) result[key] = omitUndefinedProperties(item);
	}
	return result;
}
