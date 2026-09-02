import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type OperationFinishedRecord,
	type OperationStartedRecord,
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

export type PiAgentRecoveryErrorCode =
	| "nothing_to_resume"
	| "multiple_open_operations"
	| "resume_required"
	| "unsupported_operation"
	| "outcome_unknown";

export class PiAgentRecoveryError extends Error {
	readonly code: PiAgentRecoveryErrorCode;

	constructor(code: PiAgentRecoveryErrorCode, message: string) {
		super(message);
		this.name = "PiAgentRecoveryError";
		this.code = code;
	}
}

type RecoveryTerminalOutcome = Extract<OperationFinishedRecord["outcome"], "completed" | "aborted" | "failed">;

export type PiAgentRecoveryState =
	| { status: "idle" }
	| { status: "active"; runId: string }
	| { status: "resumable"; runId: string; point: "operation_start" | "message_tail" }
	| {
			status: "settleable";
			runId: string;
			outcome: RecoveryTerminalOutcome;
			error?: { code: string; message: string };
	  }
	| {
			status: "blocked";
			runId: string;
			code: Extract<PiAgentRecoveryErrorCode, "unsupported_operation" | "outcome_unknown">;
			message: string;
	  };

export class PiAgentDriver {
	readonly events = new LiveEventBus<DriverEvents>();
	private readonly session: Session;
	private readonly agent: Agent;
	private readonly unsubscribe: () => void;
	private activeRunId?: string;
	private suspendedOperation?: OperationStartedRecord;
	private starting = false;
	private abortRequested = false;
	private abortRecordPromise?: Promise<void>;

	private constructor(
		session: Session,
		options: PiAgentDriverOptions,
		messages: AgentMessage[],
		suspendedOperation?: OperationStartedRecord,
	) {
		this.session = session;
		this.suspendedOperation = suspendedOperation;
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
		const [entries, openOperations] = await Promise.all([
			options.session.findEntriesOnBranch({ type: "message", order: "oldestFirst" }),
			options.session.findOpenOperations("main", { limit: 2 }),
		]);
		if (openOperations.length > 1) {
			throw new PiAgentRecoveryError(
				"multiple_open_operations",
				`Session has multiple unfinished operations on lane main: ${openOperations.map((operation) => operation.id).join(", ")}`,
			);
		}
		return new PiAgentDriver(
			options.session,
			options,
			entries.map((entry) => {
				if (entry.type !== "message") throw new Error("Session returned a non-message entry");
				return entry.message;
			}),
			openOperations[0],
		);
	}

	async prompt(input: string): Promise<void> {
		this.assertCanStart();
		this.starting = true;
		const runId = uuidv7();
		const message: AgentMessage = { role: "user", content: input, timestamp: Date.now() };
		try {
			const operation = await this.session.appendRecord({
				type: "operation_started",
				id: runId,
				lane: "main",
				sourceLeafId: await this.session.getLeafId(),
				intent: { kind: "run", originalPrompt: [message], initialMessages: [] },
			});
			this.suspendedOperation = operation;
			await this.runActiveOperation(operation, () => this.agent.prompt(message));
		} finally {
			this.starting = false;
		}
	}

	async getRecoveryState(): Promise<PiAgentRecoveryState> {
		if (this.activeRunId) return { status: "active", runId: this.activeRunId };
		const operation = this.suspendedOperation;
		if (!operation) return { status: "idle" };
		if (operation.intent.kind !== "run") {
			return {
				status: "blocked",
				runId: operation.id,
				code: "unsupported_operation",
				message: `Cannot resume ${operation.intent.kind} operations`,
			};
		}

		const [records, entries] = await Promise.all([
			this.session.findRecords({ lane: "main", runId: operation.id, order: "oldestFirst" }),
			this.session.findEntriesOnBranch({
				type: "message",
				order: "oldestFirst",
				cursor: { afterSeq: operation.seq },
			}),
		]);
		if (records.some((record) => record.type === "abort_requested")) {
			return { status: "settleable", runId: operation.id, outcome: "aborted" };
		}

		const messages = entries.map((entry) => {
			if (entry.type !== "message") throw new Error("Session returned a non-message entry");
			return entry.message;
		});
		const unresolvedToolCalls = new Set<string>();
		for (const message of messages) {
			if (message.role === "assistant") {
				for (const part of message.content) {
					if (part.type === "toolCall") unresolvedToolCalls.add(part.id);
				}
			} else if (message.role === "toolResult") {
				unresolvedToolCalls.delete(message.toolCallId);
			}
		}
		if (unresolvedToolCalls.size > 0) {
			return {
				status: "blocked",
				runId: operation.id,
				code: "outcome_unknown",
				message: `Cannot safely replay unresolved tool calls: ${[...unresolvedToolCalls].join(", ")}`,
			};
		}

		const lastMessage = messages.at(-1);
		if (!lastMessage) {
			if (operation.intent.initialMessages.length > 0 || operation.intent.originalPrompt.length === 0) {
				return {
					status: "blocked",
					runId: operation.id,
					code: "unsupported_operation",
					message: "Cannot resume an operation start with initial messages or an empty original prompt",
				};
			}
			return { status: "resumable", runId: operation.id, point: "operation_start" };
		}
		if (lastMessage.role === "user" || lastMessage.role === "toolResult") {
			return { status: "resumable", runId: operation.id, point: "message_tail" };
		}
		if (lastMessage.role !== "assistant") {
			return {
				status: "blocked",
				runId: operation.id,
				code: "unsupported_operation",
				message: `Cannot resume from custom message role ${lastMessage.role}`,
			};
		}
		if (lastMessage.stopReason === "aborted") {
			return { status: "settleable", runId: operation.id, outcome: "aborted" };
		}
		if (lastMessage.stopReason === "error") {
			return {
				status: "settleable",
				runId: operation.id,
				outcome: "failed",
				error: { code: "assistant_error", message: lastMessage.errorMessage ?? "Assistant request failed" },
			};
		}
		if (lastMessage.stopReason === "stop" || lastMessage.stopReason === "length") {
			return { status: "settleable", runId: operation.id, outcome: "completed" };
		}
		return {
			status: "blocked",
			runId: operation.id,
			code: "unsupported_operation",
			message: `Cannot classify assistant stop reason ${lastMessage.stopReason}`,
		};
	}

	async resume(): Promise<void> {
		this.assertCanResume();
		this.starting = true;
		try {
			const state = await this.getRecoveryState();
			const operation = this.suspendedOperation;
			if (!operation || state.status === "idle") {
				throw new PiAgentRecoveryError("nothing_to_resume", "Session has no unfinished operation to resume");
			}
			if (state.status === "active") throw new Error("Agent driver is already running");
			if (state.status === "blocked") throw new PiAgentRecoveryError(state.code, state.message);
			if (state.status === "settleable") {
				await this.appendTerminal(operation.id, state.outcome, state.error);
				this.suspendedOperation = undefined;
				return;
			}
			if (operation.intent.kind !== "run") {
				throw new PiAgentRecoveryError(
					"unsupported_operation",
					`Cannot resume ${operation.intent.kind} operations`,
				);
			}
			const originalPrompt = operation.intent.originalPrompt;
			await this.runActiveOperation(
				operation,
				state.point === "operation_start" ? () => this.agent.prompt(originalPrompt) : () => this.agent.continue(),
			);
		} finally {
			this.starting = false;
		}
	}

	private async runActiveOperation(operation: OperationStartedRecord, execute: () => Promise<void>): Promise<void> {
		const runId = operation.id;
		this.activeRunId = runId;
		this.abortRequested = false;
		this.abortRecordPromise = undefined;
		let outcome: "completed" | "aborted" | "failed" = "completed";
		let failure: unknown;
		try {
			await execute();
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
			const error =
				failure === undefined
					? undefined
					: { code: "driver_error", message: failure instanceof Error ? failure.message : String(failure) };
			let terminalCommitted = false;
			try {
				await this.appendTerminal(runId, outcome, error);
				terminalCommitted = true;
			} finally {
				this.suspendedOperation = terminalCommitted ? undefined : operation;
				this.agent.clearAllQueues();
				this.activeRunId = undefined;
				this.abortRecordPromise = undefined;
			}
		}
		if (failure !== undefined) throw failure;
	}

	steer(input: string | AgentMessage): void {
		this.assertQueueable("steer");
		this.agent.steer(normalizeQueuedMessage(input));
	}

	followUp(input: string | AgentMessage): void {
		this.assertQueueable("follow up");
		this.agent.followUp(normalizeQueuedMessage(input));
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
		this.agent.clearAllQueues();
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

	private assertQueueable(operation: string): void {
		if (!this.activeRunId) throw new Error(`Cannot ${operation}: agent driver is idle`);
		if (this.abortRequested) throw new Error(`Cannot ${operation}: agent driver is aborting`);
	}

	private assertCanStart(): void {
		if (this.activeRunId || this.starting) throw new Error("Agent driver is already running");
		if (this.suspendedOperation) {
			throw new PiAgentRecoveryError(
				"resume_required",
				`Operation ${this.suspendedOperation.id} must be resumed before starting a new prompt`,
			);
		}
	}

	private assertCanResume(): void {
		if (this.activeRunId || this.starting) throw new Error("Agent driver is already running");
	}

	private async appendTerminal(
		runId: string,
		outcome: RecoveryTerminalOutcome,
		error?: { code: string; message: string },
	): Promise<void> {
		await this.session.appendRecord({
			type: "operation_finished",
			id: uuidv7(),
			lane: "main",
			runId,
			outcome,
			...(error === undefined ? {} : { error }),
		});
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

function normalizeQueuedMessage(input: string | AgentMessage): AgentMessage {
	const message: AgentMessage =
		typeof input === "string" ? { role: "user", content: input, timestamp: Date.now() } : input;
	return normalizeDurableMessage(message);
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
