import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type AgentToolCall,
	type AgentToolResult,
	type BeforeToolCallContext,
	type BeforeToolCallResult,
	type BranchSummaryEntry,
	type BranchSummaryResult,
	buildSessionContext,
	type CompactionEntry,
	type CompactionPreparation,
	type CompactionSettings,
	type CompactResult,
	collectEntriesForBranchSummary,
	type Entry,
	type JsonValue,
	type OperationFinishedRecord,
	type OperationStartedRecord,
	type ProvisionedEntry,
	prepareCompaction,
	type Session,
	type StreamFn,
	type TelemetryContext,
	type TelemetrySpan,
	type ThinkingLevel,
	type ToolStartedRecord,
} from "@earendil-works/pi-agent-core";
import { type Api, type Model, type ToolResultMessage, uuidv7, validateToolArguments } from "@earendil-works/pi-ai";
import { LiveEventBus } from "./events.ts";

export interface PiAgentDriverOptions {
	session: Session;
	streamFn: StreamFn;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	systemPrompt?: string;
	tools?: AgentTool[];
	toolReplay?: Readonly<Record<string, "never" | "safe">>;
	toolPolicyVersions?: Readonly<Record<string, string>>;
	toolReconciliation?: ToolReconciliationConfig;
	compaction?: DriverCompactionService;
	telemetry?: TelemetryContext;
	messageCommitMiddleware?: DriverMessageCommitMiddleware;
	runPreparationMiddleware?: DriverRunPreparationMiddleware;
	toolLifecycleMiddleware?: DriverToolLifecycleMiddleware;
}

export interface DriverMessageCommitContext {
	lane: "main";
	runId?: string;
}

export interface DriverMessageCommitMiddleware {
	transform(message: AgentMessage, context: DriverMessageCommitContext): AgentMessage | Promise<AgentMessage>;
}

export interface DriverRunPreparation {
	messages: AgentMessage[];
	systemPrompt: string;
}

export interface DriverRunPreparationMiddleware {
	prepare(preparation: DriverRunPreparation): DriverRunPreparation | Promise<DriverRunPreparation>;
}

export interface DriverToolLifecycleMiddleware {
	before(context: BeforeToolCallContext, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined>;
	after(context: AfterToolCallContext, signal?: AbortSignal): Promise<AfterToolCallResult | undefined>;
}

export interface DriverCompactionService {
	settings: CompactionSettings;
	execute(
		preparation: CompactionPreparation,
		options: {
			customInstructions?: string;
			signal: AbortSignal;
			model?: Model<Api>;
			thinkingLevel?: ThinkingLevel;
		},
	): Promise<CompactResult>;
	summarizeBranch?(
		entries: Entry[],
		options: { customInstructions?: string; signal: AbortSignal; model: Model<Api> },
	): Promise<BranchSummaryResult>;
}

export interface ToolReconciliationRequest {
	runId: string;
	toolCallId: string;
	toolName: string;
	effectiveArgs: Readonly<Record<string, unknown>>;
	resultEntryId: string;
}

export type ToolReconciliationOutcome =
	| { status: "completed"; result: AgentToolResult<unknown>; isError?: boolean }
	| { status: "not_started" }
	| { status: "unknown"; reason?: string };

export interface ToolReconciliationService {
	reconcile(request: ToolReconciliationRequest): ToolReconciliationOutcome | Promise<ToolReconciliationOutcome>;
}

export interface ToolReconciliationConfig {
	version: string;
	service: ToolReconciliationService;
}

export interface DriverEvents {
	"message/committed": { entryId: string; message: AgentMessage };
	"message/transform-failed": { message: AgentMessage; error: unknown };
	"operation/started": { runId: string; kind: OperationStartedRecord["intent"]["kind"]; recovery: boolean };
	"operation/settled": { runId: string; outcome: RecoveryTerminalOutcome };
	"agent/event": AgentEvent;
}

export const REQUEST_CONFIGURATION_CUSTOM_TYPE = "pi-ds.request-configuration";

export interface RequestConfigurationAnchorV1 {
	schemaVersion: 1;
	runId: string;
	systemPrompt: string;
	model: { provider: string; id: string };
	thinkingLevel: ThinkingLevel;
	reconciliationVersion?: string;
	tools: {
		name: string;
		description: string;
		parameters: JsonValue;
		replay: "never" | "safe";
		policyVersion?: string;
	}[];
}

export interface ClearedAgentQueues {
	steering: AgentMessage[];
	followUp: AgentMessage[];
}

export type PiAgentRecoveryErrorCode =
	| "nothing_to_resume"
	| "multiple_open_operations"
	| "resume_required"
	| "unsupported_operation"
	| "configuration_mismatch"
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
	| {
			status: "resumable";
			runId: string;
			point: "operation_start" | "initial_messages" | "message_tail" | "tool_batch" | "navigation";
	  }
	| {
			status: "settleable";
			runId: string;
			outcome: RecoveryTerminalOutcome;
			error?: { code: string; message: string };
	  }
	| {
			status: "blocked";
			runId: string;
			code: Extract<
				PiAgentRecoveryErrorCode,
				"unsupported_operation" | "configuration_mismatch" | "outcome_unknown"
			>;
			message: string;
	  };

export class PiAgentDriver {
	readonly events = new LiveEventBus<DriverEvents>();
	private readonly session: Session;
	private readonly sessionId: string;
	private readonly agent: Agent;
	private readonly unsubscribe: () => void;
	private toolReplay: Readonly<Record<string, "never" | "safe">>;
	private toolPolicyVersions: Readonly<Record<string, string>>;
	private readonly toolReconciliation?: ToolReconciliationConfig;
	private readonly compaction?: DriverCompactionService;
	private readonly telemetry?: TelemetryContext;
	private readonly messageCommitMiddleware?: DriverMessageCommitMiddleware;
	private readonly runPreparationMiddleware?: DriverRunPreparationMiddleware;
	private readonly baseSystemPrompt: string;
	private readonly toolLifecycleMiddleware?: DriverToolLifecycleMiddleware;
	private readonly reconciledToolCalls = new Map<string, ToolReconciliationOutcome>();
	private readonly toolCalls = new Map<string, { assistantEntryId: string; toolIndex: number }>();
	private readonly pendingToolResults = new Map<string, { resultEntryId: string }>();
	private readonly queuedEntryIds = new WeakMap<object, string>();
	private readonly pendingQueueEntries = new Map<
		string,
		{ runId: string; queue: "steer" | "followUp"; message: AgentMessage }
	>();
	private queueMutationTail: Promise<void> = Promise.resolve();
	private activeRunId?: string;
	private suspendedOperation?: OperationStartedRecord;
	private recoveryConfigurationIssue?: Extract<PiAgentRecoveryState, { status: "blocked" }>;
	private hasRecoveryConfigurationAnchor = false;
	private starting = false;
	private abortRequested = false;
	private abortRecordPromise?: Promise<void>;
	private recoveryAbortController?: AbortController;
	private assistantAttempt = 0;
	private activeTelemetryContext?: TelemetryContext;
	private activeRecovery = false;
	private activeOperationPromise?: Promise<void>;

	private constructor(
		session: Session,
		sessionId: string,
		options: PiAgentDriverOptions,
		messages: AgentMessage[],
		suspendedOperation?: OperationStartedRecord,
		recoveryConfigurationIssue?: Extract<PiAgentRecoveryState, { status: "blocked" }>,
	) {
		this.session = session;
		this.sessionId = sessionId;
		this.suspendedOperation = suspendedOperation;
		this.recoveryConfigurationIssue = recoveryConfigurationIssue;
		this.toolReplay = options.toolReplay ?? {};
		this.toolPolicyVersions = options.toolPolicyVersions ?? {};
		this.toolReconciliation = options.toolReconciliation;
		this.compaction = options.compaction;
		this.telemetry = options.telemetry;
		this.messageCommitMiddleware = options.messageCommitMiddleware;
		this.runPreparationMiddleware = options.runPreparationMiddleware;
		this.baseSystemPrompt = options.systemPrompt ?? "";
		this.toolLifecycleMiddleware = options.toolLifecycleMiddleware;
		this.agent = new Agent({
			streamFn: options.streamFn,
			beforeToolCall: (toolContext, signal) => this.handleBeforeToolCall(toolContext, signal),
			afterToolCall: async (toolContext, signal) => this.toolLifecycleMiddleware?.after(toolContext, signal),
			initialState: {
				messages,
				model: options.model,
				thinkingLevel: options.thinkingLevel,
				systemPrompt: options.systemPrompt ?? "",
				tools: (options.tools ?? []).map((tool) => this.instrumentTool(tool)),
			},
		});
		this.unsubscribe = this.agent.subscribe((event) => this.handleAgentEvent(event));
	}

	get model(): Model<any> {
		return this.agent.state.model;
	}

	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	get toolNames(): string[] {
		return this.agent.state.tools.map((tool) => tool.name);
	}

	setModel(model: Model<any>): void {
		this.assertConfigurationMutable("model");
		this.agent.state.model = model;
	}

	setThinkingLevel(level: ThinkingLevel): void {
		this.assertConfigurationMutable("thinking level");
		this.agent.state.thinkingLevel = level;
	}

	setTools(
		tools: AgentTool[],
		toolReplay: Readonly<Record<string, "never" | "safe">> = {},
		toolPolicyVersions: Readonly<Record<string, string>> = {},
	): void {
		this.assertConfigurationMutable("active tools");
		this.toolReplay = { ...toolReplay };
		this.toolPolicyVersions = { ...toolPolicyVersions };
		this.agent.state.tools = tools.map((tool) => this.instrumentTool(tool));
	}

	async navigateTo(entryId: string | null): Promise<void> {
		return this.navigateTree(entryId);
	}

	async navigateTree(
		entryId: string | null,
		options: { summarize?: boolean; customInstructions?: string; label?: string } = {},
	): Promise<void> {
		this.assertCanStart();
		if (this.hasPendingMessages()) throw new Error("Cannot navigate while queued messages are pending");
		if (entryId !== null && !(await this.session.getEntry(entryId))) {
			throw new Error(`Cannot navigate to missing Session entry: ${entryId}`);
		}
		const sourceLeafId = await this.session.getLeafId();
		if (sourceLeafId === entryId) return;
		const summarize = options.summarize === true && sourceLeafId !== null;
		if (summarize && !this.compaction?.summarizeBranch) {
			throw new Error("Branch summarization service is not available");
		}
		this.starting = true;
		try {
			const operation = await this.session.appendRecord({
				type: "operation_started",
				id: uuidv7(),
				lane: "main",
				sourceLeafId,
				intent: {
					kind: "navigation",
					targetId: entryId,
					summarize,
					...(options.customInstructions === undefined ? {} : { customInstructions: options.customInstructions }),
					...(options.label === undefined ? {} : { label: options.label }),
					...(summarize ? { summaryEntryId: uuidv7() } : {}),
				},
			});
			this.suspendedOperation = operation;
			await flushSession(this.session);
			await this.runActiveOperation(operation, () => this.executeNavigation(operation));
		} finally {
			this.starting = false;
		}
	}

	private assertConfigurationMutable(kind: string): void {
		if (!this.isIdle()) throw new Error(`Cannot change ${kind} while the Agent Driver is active`);
	}

	static async create(options: PiAgentDriverOptions): Promise<PiAgentDriver> {
		const [entries, openOperations, metadata] = await Promise.all([
			options.session.findEntriesOnBranch({ order: "oldestFirst" }),
			options.session.findOpenOperations("main", { limit: 2 }),
			options.session.getMetadata(),
		]);
		if (openOperations.length > 1) {
			throw new PiAgentRecoveryError(
				"multiple_open_operations",
				`Session has multiple unfinished operations on lane main: ${openOperations.map((operation) => operation.id).join(", ")}`,
			);
		}
		const driver = new PiAgentDriver(
			options.session,
			metadata.id,
			options,
			buildSessionContext(entries).messages,
			openOperations[0],
		);
		const operation = openOperations[0];
		if (operation?.sourceLeafId) {
			const sourceEntry = await options.session.getEntry(operation.sourceLeafId);
			if (sourceEntry?.type === "custom" && sourceEntry.customType === REQUEST_CONFIGURATION_CUSTOM_TYPE) {
				driver.hasRecoveryConfigurationAnchor = true;
				driver.recoveryConfigurationIssue = validateRecoveryConfiguration(
					operation.id,
					sourceEntry.data,
					driver.captureRequestConfiguration(
						operation.id,
						operation.intent.kind === "run" ? operation.intent.systemPromptOverride : undefined,
					),
				);
			}
		}
		if (operation) await driver.restoreQueuedMessages(operation);
		return driver;
	}

	async compact(options: { customInstructions?: string } = {}): Promise<CompactionEntry | undefined> {
		this.assertCanStart();
		if (!this.compaction) throw new Error("Compaction service is not available");
		const entries = await this.session.findEntriesOnBranch({ order: "oldestFirst" });
		const prepared = prepareCompaction(entries, this.compaction.settings);
		if (!prepared.ok) throw prepared.error;
		if (!prepared.value) return undefined;
		this.starting = true;
		const runId = uuidv7();
		const resultEntryId = uuidv7();
		const operation = await this.session.appendRecord({
			type: "operation_started",
			id: runId,
			lane: "main",
			sourceLeafId: await this.session.getLeafId(),
			intent: {
				kind: "compaction",
				...(options.customInstructions === undefined ? {} : { customInstructions: options.customInstructions }),
				resultEntryId,
			},
		});
		this.suspendedOperation = operation;
		await flushSession(this.session);
		let entry: CompactionEntry | undefined;
		const controller = new AbortController();
		this.recoveryAbortController = controller;
		try {
			await this.runActiveOperation(operation, async () => {
				await this.session.appendRecord({
					type: "step_attempt",
					id: uuidv7(),
					lane: "main",
					runId,
					step: "compaction",
					attempt: 1,
					resultEntryId,
					compactionReason: "manual",
				});
				await flushSession(this.session);
				const result = await this.compaction!.execute(prepared.value!, {
					customInstructions: options.customInstructions,
					signal: controller.signal,
					model: this.agent.state.model,
					thinkingLevel: this.agent.state.thinkingLevel,
				});
				entry = await this.session.appendEntry(
					{
						type: "compaction",
						id: resultEntryId,
						summary: result.summary,
						retainedTail: result.retainedTail,
						tokensBefore: result.tokensBefore,
						...(result.details === undefined ? {} : { details: result.details }),
						...(result.usage === undefined ? {} : { usage: result.usage }),
					},
					"main",
				);
				if (result.usage) {
					await this.session.appendRecord({
						type: "usage",
						id: uuidv7(),
						lane: "main",
						runId,
						cause: "compaction",
						entryId: resultEntryId,
						attempt: 1,
						stopReason: "stop",
						usage: result.usage,
					});
				}
				await flushSession(this.session);
				this.agent.state.messages = buildSessionContext(
					await this.session.findEntriesOnBranch({ order: "oldestFirst" }),
				).messages;
			});
			return entry;
		} finally {
			controller.abort();
			if (this.recoveryAbortController === controller) this.recoveryAbortController = undefined;
			this.starting = false;
		}
	}

	private async executeNavigation(operation: OperationStartedRecord): Promise<void> {
		if (operation.intent.kind !== "navigation") throw new Error("Expected a navigation operation");
		const { targetId } = operation.intent;
		if (targetId !== null && !(await this.session.getEntry(targetId))) {
			throw new Error(`Cannot navigate to missing Session entry: ${targetId}`);
		}
		await this.session.moveLane("main", targetId);
		await flushSession(this.session);
		if (operation.intent.summarize) await this.executeBranchSummary(operation);
		const entries = await this.session.findEntriesOnBranch({ order: "oldestFirst" });
		this.agent.state.messages = buildSessionContext(entries).messages;
	}

	private async executeBranchSummary(operation: OperationStartedRecord): Promise<BranchSummaryEntry> {
		if (operation.intent.kind !== "navigation" || !operation.intent.summarize) {
			throw new Error("Expected a summarized navigation operation");
		}
		const summaryEntryId = operation.intent.summaryEntryId;
		if (!summaryEntryId || !operation.sourceLeafId) throw new Error("Navigation summary intent is incomplete");
		const existing = await this.session.getEntry(summaryEntryId);
		if (existing) {
			if (existing.type !== "branch_summary") throw new Error("Navigation summary id belongs to another entry type");
			return existing;
		}
		const service = this.compaction?.summarizeBranch;
		if (!service) throw new Error("Branch summarization service is not available");
		const attempts = await this.session.findRecords({
			type: "step_attempt",
			runId: operation.id,
			order: "oldestFirst",
		});
		const attempt =
			Math.max(0, ...attempts.flatMap((record) => (record.step === "branch_summary" ? [record.attempt] : []))) + 1;
		await this.session.appendRecord({
			type: "step_attempt",
			id: uuidv7(),
			lane: "main",
			runId: operation.id,
			step: "branch_summary",
			attempt,
			resultEntryId: summaryEntryId,
		});
		await flushSession(this.session);
		const abandoned =
			operation.intent.targetId === null
				? await this.session.findEntriesOnBranch({
						start: operation.sourceLeafId,
						order: "oldestFirst",
					})
				: (await collectEntriesForBranchSummary(this.session, operation.sourceLeafId, operation.intent.targetId))
						.entries;
		const controller = new AbortController();
		this.recoveryAbortController = controller;
		try {
			const result = await service(abandoned, {
				customInstructions: operation.intent.customInstructions,
				signal: controller.signal,
				model: this.agent.state.model,
			});
			if (controller.signal.aborted) throw new Error("Branch summarization aborted");
			const entry = await this.session.appendEntry<BranchSummaryEntry>(
				{
					type: "branch_summary",
					id: summaryEntryId,
					fromId: operation.sourceLeafId,
					summary: result.summary,
					details: { readFiles: result.readFiles, modifiedFiles: result.modifiedFiles },
					...(result.usage === undefined ? {} : { usage: result.usage }),
				},
				"main",
			);
			if (operation.intent.label !== undefined) {
				await this.session.setLabel(entry.id, operation.intent.label);
			}
			if (result.usage) {
				await this.session.appendRecord({
					type: "usage",
					id: uuidv7(),
					lane: "main",
					runId: operation.id,
					cause: "branch_summary",
					entryId: summaryEntryId,
					attempt,
					stopReason: "stop",
					usage: result.usage,
				});
			}
			await flushSession(this.session);
			return entry;
		} finally {
			controller.abort();
			if (this.recoveryAbortController === controller) this.recoveryAbortController = undefined;
		}
	}

	async prompt(input: string | AgentMessage): Promise<void> {
		this.assertCanStart();
		this.starting = true;
		const runId = uuidv7();
		const message = normalizeQueuedMessage(input);
		try {
			const preparation = await this.prepareRun([message]);
			const initialMessages: ProvisionedEntry[] = preparation.messages.map((preparedMessage) => ({
				type: "message",
				id: uuidv7(),
				message: preparedMessage,
			}));
			const configuration = this.captureRequestConfiguration(runId, preparation.systemPrompt);
			const configurationEntryId = await this.session.appendCustomEntry(
				REQUEST_CONFIGURATION_CUSTOM_TYPE,
				configuration,
			);
			const operation = await this.session.appendRecord({
				type: "operation_started",
				id: runId,
				lane: "main",
				sourceLeafId: configurationEntryId,
				intent: {
					kind: "run",
					originalPrompt: [message],
					initialMessages,
					systemPromptOverride: configuration.systemPrompt,
				},
			});
			this.suspendedOperation = operation;
			await flushSession(this.session);
			this.agent.state.systemPrompt = preparation.systemPrompt;
			for (const [index, preparedMessage] of preparation.messages.entries()) {
				this.queuedEntryIds.set(preparedMessage, initialMessages[index]!.id);
			}
			await this.runActiveOperation(operation, () => this.agent.prompt(preparation.messages));
		} finally {
			this.starting = false;
		}
	}

	async getRecoveryState(): Promise<PiAgentRecoveryState> {
		if (this.activeRunId) return { status: "active", runId: this.activeRunId };
		const operation = this.suspendedOperation;
		if (!operation) return { status: "idle" };
		if (this.recoveryConfigurationIssue) return structuredClone(this.recoveryConfigurationIssue);
		if (operation.intent.kind === "navigation") return this.getNavigationRecoveryState(operation);
		if (operation.intent.kind === "compaction") return this.getCompactionRecoveryState(operation);

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
		const committedEntryIds = new Set(entries.map((entry) => entry.id));
		const missingInitialMessages = operation.intent.initialMessages.filter(
			(entry) => !committedEntryIds.has(entry.id),
		);
		const unresolvedToolCalls = new Map<
			string,
			{ assistantEntryId: string; toolIndex: number; toolCall: AgentToolCall }
		>();
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "assistant") {
				const calls = message.content.filter((part): part is AgentToolCall => part.type === "toolCall");
				for (const [toolIndex, toolCall] of calls.entries()) {
					unresolvedToolCalls.set(toolCall.id, { assistantEntryId: entry.id, toolIndex, toolCall });
				}
			} else if (message.role === "toolResult") {
				unresolvedToolCalls.delete(message.toolCallId);
			}
		}
		if (unresolvedToolCalls.size > 0) {
			const starts = records.filter((record) => record.type === "tool_started");
			const unsafe: string[] = [];
			for (const call of unresolvedToolCalls.values()) {
				const started = starts.find(
					(record) => record.assistantEntryId === call.assistantEntryId && record.toolIndex === call.toolIndex,
				);
				if (!started && !this.hasRecoveryConfigurationAnchor) {
					unsafe.push(call.toolCall.id);
					continue;
				}
				if (started?.replay === "never") {
					const reconciliation = await this.reconcileStartedTool(operation.id, started);
					if (reconciliation.status === "unknown") unsafe.push(call.toolCall.id);
				}
			}
			if (unsafe.length === 0) {
				return { status: "resumable", runId: operation.id, point: "tool_batch" };
			}
			return {
				status: "blocked",
				runId: operation.id,
				code: "outcome_unknown",
				message: `Cannot safely replay unresolved tool calls: ${unsafe.join(", ")}`,
			};
		}

		const lastMessage = messages.at(-1);
		if (!lastMessage) {
			if (operation.intent.initialMessages.length === 0 && operation.intent.originalPrompt.length === 0) {
				return {
					status: "blocked",
					runId: operation.id,
					code: "unsupported_operation",
					message: "Cannot resume an operation start with an empty prompt",
				};
			}
			return { status: "resumable", runId: operation.id, point: "operation_start" };
		}
		if (missingInitialMessages.length > 0) {
			return { status: "resumable", runId: operation.id, point: "initial_messages" };
		}
		if (lastMessage.role === "user" || lastMessage.role === "toolResult") {
			return { status: "resumable", runId: operation.id, point: "message_tail" };
		}
		if (lastMessage.role !== "assistant") {
			const lastEntryId = entries.at(-1)?.id;
			if (lastEntryId && operation.intent.initialMessages.some((entry) => entry.id === lastEntryId)) {
				return { status: "resumable", runId: operation.id, point: "message_tail" };
			}
			return {
				status: "blocked",
				runId: operation.id,
				code: "unsupported_operation",
				message: `Cannot resume from custom message role ${lastMessage.role}`,
			};
		}
		if (this.agent.hasQueuedMessages()) {
			return { status: "resumable", runId: operation.id, point: "message_tail" };
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

	private async getNavigationRecoveryState(operation: OperationStartedRecord): Promise<PiAgentRecoveryState> {
		if (operation.intent.kind !== "navigation") throw new Error("Expected a navigation operation");
		const records = await this.session.findRecords({ lane: "main", runId: operation.id });
		if (records.some((record) => record.type === "abort_requested")) {
			return { status: "settleable", runId: operation.id, outcome: "aborted" };
		}
		if (operation.intent.targetId !== null && !(await this.session.getEntry(operation.intent.targetId))) {
			return {
				status: "blocked",
				runId: operation.id,
				code: "unsupported_operation",
				message: `Navigation target is missing: ${operation.intent.targetId}`,
			};
		}
		if (operation.intent.summarize) {
			const summaryEntryId = operation.intent.summaryEntryId;
			if (!summaryEntryId || !operation.sourceLeafId) {
				return {
					status: "blocked",
					runId: operation.id,
					code: "unsupported_operation",
					message: `Navigation operation ${operation.id} has an incomplete summary intent`,
				};
			}
			const summary = await this.session.getEntry(summaryEntryId);
			if (summary) {
				return summary.type === "branch_summary"
					? { status: "settleable", runId: operation.id, outcome: "completed" }
					: {
							status: "blocked",
							runId: operation.id,
							code: "unsupported_operation",
							message: `Navigation summary id ${summaryEntryId} belongs to ${summary.type}`,
						};
			}
			return { status: "resumable", runId: operation.id, point: "navigation" };
		}
		return (await this.session.getLeafId()) === operation.intent.targetId
			? { status: "settleable", runId: operation.id, outcome: "completed" }
			: { status: "resumable", runId: operation.id, point: "navigation" };
	}

	private async getCompactionRecoveryState(operation: OperationStartedRecord): Promise<PiAgentRecoveryState> {
		if (operation.intent.kind !== "compaction") throw new Error("Expected a compaction operation");
		const records = await this.session.findRecords({ lane: "main", runId: operation.id });
		if (records.some((record) => record.type === "abort_requested")) {
			return { status: "settleable", runId: operation.id, outcome: "aborted" };
		}
		const result = await this.session.getEntry(operation.intent.resultEntryId);
		if (!result) {
			return {
				status: "blocked",
				runId: operation.id,
				code: "unsupported_operation",
				message: `Cannot safely retry compaction operation ${operation.id} before its result is durable`,
			};
		}
		return result.type === "compaction"
			? { status: "settleable", runId: operation.id, outcome: "completed" }
			: {
					status: "blocked",
					runId: operation.id,
					code: "unsupported_operation",
					message: `Compaction result id ${operation.intent.resultEntryId} belongs to ${result.type}`,
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
				if (operation.intent.kind === "navigation" && state.status === "resumable") {
					await this.runActiveOperation(operation, () => this.executeNavigation(operation), true);
					return;
				}
				throw new PiAgentRecoveryError(
					"unsupported_operation",
					`Cannot resume ${operation.intent.kind} operations`,
				);
			}
			const originalPrompt = operation.intent.originalPrompt;
			const effectivePrompt =
				operation.intent.initialMessages.length > 0
					? operation.intent.initialMessages.map((entry) => {
							if (entry.type !== "message") throw new Error("Run initial input must be a message");
							const message = normalizeDurableMessage(entry.message);
							this.queuedEntryIds.set(message, entry.id);
							return message;
						})
					: originalPrompt;
			this.agent.state.systemPrompt = operation.intent.systemPromptOverride ?? this.baseSystemPrompt;
			await this.runActiveOperation(
				operation,
				state.point === "operation_start"
					? () => this.agent.prompt(effectivePrompt)
					: state.point === "initial_messages"
						? async () => this.agent.prompt(await this.restoreMissingInitialMessages(operation))
						: state.point === "tool_batch"
							? async () => {
									await this.resumeToolBatch(operation);
									if (!this.abortRequested) await this.agent.continue();
								}
							: () => this.agent.continue(),
				true,
			);
		} finally {
			this.starting = false;
		}
	}

	private async restoreMissingInitialMessages(operation: OperationStartedRecord): Promise<AgentMessage[]> {
		if (operation.intent.kind !== "run") return [];
		const committedIds = new Set((await this.session.findEntries()).map((entry) => entry.id));
		return operation.intent.initialMessages.flatMap((entry) => {
			if (entry.type !== "message" || committedIds.has(entry.id)) return [];
			const message = normalizeDurableMessage(entry.message);
			this.queuedEntryIds.set(message, entry.id);
			return [message];
		});
	}

	private async runActiveOperation(
		operation: OperationStartedRecord,
		execute: () => Promise<void>,
		recovery = false,
	): Promise<void> {
		const task = this.runActiveOperationTracked(operation, execute, recovery);
		this.activeOperationPromise = task;
		try {
			await task;
		} finally {
			if (this.activeOperationPromise === task) this.activeOperationPromise = undefined;
		}
	}

	private runActiveOperationTracked(
		operation: OperationStartedRecord,
		execute: () => Promise<void>,
		recovery: boolean,
	): Promise<void> {
		if (!this.telemetry) return this.runActiveOperationBody(operation, execute, recovery);
		const spanName =
			operation.intent.kind === "compaction"
				? "pi.harness.compaction"
				: operation.intent.kind === "navigation"
					? "pi.harness.navigation"
					: "pi.harness.run";
		return this.telemetry.startSpan(
			{
				name: spanName,
				attributes: {
					"pi.session.id": this.sessionId,
					"pi.lane.name": "main",
					"pi.operation.id": operation.id,
					"pi.operation.recovery": recovery,
					"pi.operation.kind": operation.intent.kind,
				},
			},
			async (span) => {
				const previousContext = this.activeTelemetryContext;
				this.activeTelemetryContext = span;
				try {
					await this.runActiveOperationBody(operation, execute, recovery, span);
				} finally {
					this.activeTelemetryContext = previousContext;
				}
			},
		);
	}

	private async runActiveOperationBody(
		operation: OperationStartedRecord,
		execute: () => Promise<void>,
		recovery: boolean,
		span?: TelemetrySpan,
	): Promise<void> {
		const runId = operation.id;
		const existingUsage = await this.session.findRecords({ type: "usage", runId });
		this.assistantAttempt = Math.max(
			0,
			...existingUsage.flatMap((record) => (record.cause === "assistant" ? [record.attempt] : [])),
		);
		this.activeRunId = runId;
		this.activeRecovery = recovery;
		this.abortRequested = false;
		this.abortRecordPromise = undefined;
		await this.events.emit("operation/started", { runId, kind: operation.intent.kind, recovery });
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
				span?.setAttributes({ "pi.operation.outcome": outcome });
				if (failure !== undefined) span?.setStatus({ status: "error", error: telemetryError(failure) });
				this.suspendedOperation = terminalCommitted ? undefined : operation;
				this.agent.clearAllQueues();
				this.activeRunId = undefined;
				this.activeRecovery = false;
				this.abortRecordPromise = undefined;
				if (terminalCommitted) await this.events.emit("operation/settled", { runId, outcome });
			}
		}
		if (failure !== undefined) throw failure;
	}

	private instrumentTool(tool: AgentTool): AgentTool {
		if (!this.telemetry) return tool;
		return {
			...tool,
			execute: async (toolCallId, params, signal, onUpdate) => {
				const runId = this.activeRunId;
				if (!runId) return tool.execute(toolCallId, params as never, signal, onUpdate);
				const telemetry = this.activeTelemetryContext ?? this.telemetry!;
				return telemetry.startSpan(
					{
						name: "pi.harness.tool",
						attributes: {
							"pi.lane.name": "main",
							"pi.operation.id": runId,
							"pi.tool.name": tool.name,
							"pi.tool.call_id": toolCallId,
							"pi.tool.replay": this.replayPolicy(tool.name),
							"pi.tool.recovery": this.activeRecovery,
						},
					},
					async (span) => {
						try {
							const result = await tool.execute(toolCallId, params as never, signal, onUpdate);
							span.setAttributes({ "pi.tool.is_error": false });
							return result;
						} catch (error) {
							span.setAttributes({ "pi.tool.is_error": true });
							span.setStatus({ status: "error", error: telemetryError(error) });
							throw error;
						}
					},
				);
			},
		};
	}

	async steer(input: string | AgentMessage): Promise<void> {
		await this.enqueue("steer", input);
	}

	async followUp(input: string | AgentMessage): Promise<void> {
		await this.enqueue("followUp", input);
	}

	async clearQueue(): Promise<ClearedAgentQueues> {
		return this.serializeQueueMutation(async () => {
			const cleared: ClearedAgentQueues = { steering: [], followUp: [] };
			const pendingEntries = [...this.pendingQueueEntries];
			const cancelledEntryIds: string[] = [];
			try {
				for (const [entryId, pending] of pendingEntries) {
					await this.session.appendRecord({
						type: "queue_cancelled",
						id: uuidv7(),
						lane: "main",
						runId: pending.runId,
						entryId,
					});
					await flushSession(this.session);
					cancelledEntryIds.push(entryId);
					cleared[pending.queue === "steer" ? "steering" : "followUp"].push(structuredClone(pending.message));
				}
			} catch (error) {
				this.agent.clearAllQueues();
				for (const entryId of cancelledEntryIds) this.pendingQueueEntries.delete(entryId);
				for (const pending of this.pendingQueueEntries.values()) {
					if (pending.queue === "steer") this.agent.steer(pending.message);
					else this.agent.followUp(pending.message);
				}
				throw error;
			}
			this.agent.clearAllQueues();
			for (const [entryId] of pendingEntries) this.pendingQueueEntries.delete(entryId);
			return cleared;
		});
	}

	abort(): void {
		if (!this.activeRunId) return;
		this.abortRequested = true;
		this.abortRecordPromise ??= this.recordAbort(this.activeRunId);
		this.recoveryAbortController?.abort();
		this.agent.clearAllQueues();
		this.agent.abort();
	}

	isIdle(): boolean {
		return !this.activeRunId && !this.starting;
	}

	get signal(): AbortSignal | undefined {
		return this.agent.signal ?? this.recoveryAbortController?.signal;
	}

	hasPendingMessages(): boolean {
		return this.pendingQueueEntries.size > 0;
	}

	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	async appendContextMessage(message: AgentMessage): Promise<string> {
		this.assertCanStart();
		const normalized = normalizeDurableMessage(message);
		const entryId = await this.session.appendMessage(normalized);
		await flushSession(this.session);
		this.agent.state.messages = [...this.agent.state.messages, normalized];
		await this.events.emit("message/committed", { entryId, message: normalized });
		return entryId;
	}

	async waitForIdle(): Promise<void> {
		await Promise.all([this.agent.waitForIdle(), this.activeOperationPromise]);
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

	private async enqueue(queue: "steer" | "followUp", input: string | AgentMessage): Promise<void> {
		await this.serializeQueueMutation(async () => {
			this.assertQueueable(queue === "steer" ? "steer" : "follow up");
			const runId = this.activeRunId!;
			const message = normalizeQueuedMessage(input);
			const entryId = uuidv7();
			const target: ProvisionedEntry = { type: "message", id: entryId, message };
			await this.session.appendRecord({
				type: "queue_enqueued",
				id: uuidv7(),
				lane: "main",
				runId,
				queue,
				target,
			});
			await flushSession(this.session);
			if (this.abortRequested || this.activeRunId !== runId) {
				await this.cancelQueueEntry(runId, entryId);
				return;
			}
			this.queuedEntryIds.set(message, entryId);
			this.pendingQueueEntries.set(entryId, { runId, queue, message });
			if (queue === "steer") this.agent.steer(message);
			else this.agent.followUp(message);
		});
	}

	private serializeQueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
		const result = this.queueMutationTail.then(mutation, mutation);
		this.queueMutationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
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
		await flushSession(this.session);
	}

	private captureRequestConfiguration(
		runId: string,
		systemPrompt = this.agent.state.systemPrompt,
	): RequestConfigurationAnchorV1 {
		return {
			schemaVersion: 1,
			runId,
			systemPrompt,
			model: { provider: this.agent.state.model.provider, id: this.agent.state.model.id },
			thinkingLevel: this.agent.state.thinkingLevel,
			...(this.toolReconciliation ? { reconciliationVersion: this.toolReconciliation.version } : {}),
			tools: this.agent.state.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: omitUndefinedProperties(tool.parameters) as JsonValue,
				replay: this.replayPolicy(tool.name),
				...(this.toolPolicyVersions[tool.name] ? { policyVersion: this.toolPolicyVersions[tool.name] } : {}),
			})),
		};
	}

	private async prepareRun(messages: AgentMessage[]): Promise<DriverRunPreparation> {
		const base: DriverRunPreparation = { messages, systemPrompt: this.baseSystemPrompt };
		const prepared = this.runPreparationMiddleware
			? await this.runPreparationMiddleware.prepare(structuredClone(base))
			: base;
		if (prepared.messages.length === 0) throw new Error("Run preparation must retain at least one input message");
		return {
			messages: prepared.messages.map(normalizeDurableMessage),
			systemPrompt: prepared.systemPrompt,
		};
	}

	private replayPolicy(toolName: string): "never" | "safe" {
		return this.toolReplay[toolName] ?? "never";
	}

	private async handleBeforeToolCall(
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	): Promise<BeforeToolCallResult | undefined> {
		if (!this.activeRunId) throw new Error("Tool execution started outside an active operation");
		const lifecycleResult = await this.toolLifecycleMiddleware?.before(context, signal);
		if (lifecycleResult?.block) return lifecycleResult;
		const call = this.toolCalls.get(context.toolCall.id);
		if (!call) throw new Error(`Assistant entry is missing for tool call ${context.toolCall.id}`);
		const resultEntryId = uuidv7();
		await this.session.appendRecord({
			type: "tool_started",
			id: uuidv7(),
			lane: "main",
			runId: this.activeRunId,
			assistantEntryId: call.assistantEntryId,
			toolIndex: call.toolIndex,
			toolCallId: context.toolCall.id,
			toolName: context.toolCall.name,
			effectiveArgs: omitUndefinedProperties(context.args) as { [key: string]: unknown },
			resultEntryId,
			replay: this.replayPolicy(context.toolCall.name),
		});
		await flushSession(this.session);
		this.pendingToolResults.set(context.toolCall.id, { resultEntryId });
		if (signal?.aborted) return undefined;
		return lifecycleResult;
	}

	private async handleAgentEvent(event: AgentEvent): Promise<void> {
		if (event.type === "message_start") {
			const queuedEntryId = this.queuedEntryIds.get(event.message);
			if (queuedEntryId) this.pendingQueueEntries.delete(queuedEntryId);
		}
		if (event.type === "message_end") {
			const transformed = await this.transformMessageBeforeCommit(event.message);
			const message = normalizeDurableMessage(transformed);
			this.replaceMessageInPlace(event.message, message);
			const messages = this.agent.state.messages.slice();
			messages[messages.length - 1] = message;
			this.agent.state.messages = messages;
			const pendingResult =
				message.role === "toolResult" ? this.pendingToolResults.get(message.toolCallId) : undefined;
			const queuedEntryId = this.queuedEntryIds.get(event.message);
			const entryId = pendingResult
				? (await this.session.appendEntry({ type: "message", id: pendingResult.resultEntryId, message }, "main")).id
				: queuedEntryId
					? (await this.session.appendEntry({ type: "message", id: queuedEntryId, message }, "main")).id
					: await this.session.appendMessage(message);
			await this.appendUsage(this.activeRunId, entryId, message);
			await flushSession(this.session);
			if (message.role === "assistant") {
				const calls = message.content.filter((part): part is AgentToolCall => part.type === "toolCall");
				for (const [toolIndex, toolCall] of calls.entries()) {
					this.toolCalls.set(toolCall.id, { assistantEntryId: entryId, toolIndex });
				}
			} else if (message.role === "toolResult") {
				this.pendingToolResults.delete(message.toolCallId);
				this.toolCalls.delete(message.toolCallId);
			}
			if (queuedEntryId) this.pendingQueueEntries.delete(queuedEntryId);
			await this.events.emit("message/committed", { entryId, message });
		}
		await this.events.emit("agent/event", event);
	}

	private async transformMessageBeforeCommit(message: AgentMessage): Promise<AgentMessage> {
		if (!this.messageCommitMiddleware) return message;
		try {
			const transformed = await this.messageCommitMiddleware.transform(message, {
				lane: "main",
				runId: this.activeRunId,
			});
			if (transformed.role !== message.role) {
				throw new Error("Message commit middleware must preserve the message role");
			}
			return transformed;
		} catch (error) {
			await this.events.emit("message/transform-failed", { message, error });
			return message;
		}
	}

	private replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		if (target === replacement) return;
		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) delete targetRecord[key];
		Object.assign(targetRecord, replacement);
	}

	private async appendUsage(runId: string | undefined, entryId: string, message: AgentMessage): Promise<void> {
		if (!runId) return;
		if (message.role === "assistant" && message.stopReason !== "pending") {
			this.assistantAttempt++;
			await this.session.appendRecord({
				type: "usage",
				id: uuidv7(),
				lane: "main",
				runId,
				cause: "assistant",
				entryId,
				attempt: this.assistantAttempt,
				stopReason: message.stopReason,
				usage: message.usage,
			});
		} else if (message.role === "toolResult" && message.usage) {
			await this.session.appendRecord({
				type: "usage",
				id: uuidv7(),
				lane: "main",
				runId,
				cause: "tool",
				entryId,
				toolCallId: message.toolCallId,
				usage: message.usage,
			});
		}
	}

	private async cancelQueueEntry(runId: string, entryId: string): Promise<void> {
		await this.session.appendRecord({
			type: "queue_cancelled",
			id: uuidv7(),
			lane: "main",
			runId,
			entryId,
		});
		await flushSession(this.session);
		this.pendingQueueEntries.delete(entryId);
	}

	private async recordAbort(runId: string): Promise<void> {
		await this.session.appendRecord({
			type: "abort_requested",
			id: uuidv7(),
			lane: "main",
			runId,
		});
		await flushSession(this.session);
		await this.serializeQueueMutation(async () => {
			for (const [entryId, pending] of [...this.pendingQueueEntries]) {
				if (pending.runId === runId) await this.cancelQueueEntry(runId, entryId);
			}
		});
	}

	private async resumeToolBatch(operation: OperationStartedRecord): Promise<void> {
		const [entries, records] = await Promise.all([
			this.session.findEntriesOnBranch({
				type: "message",
				order: "oldestFirst",
				cursor: { afterSeq: operation.seq },
			}),
			this.session.findRecords({ lane: "main", runId: operation.id, order: "oldestFirst" }),
		]);
		const unresolved = unresolvedToolCalls(entries);
		this.recoveryAbortController = new AbortController();
		try {
			for (const call of unresolved) {
				if (this.recoveryAbortController.signal.aborted) return;
				const tool = this.agent.state.tools.find((candidate) => candidate.name === call.toolCall.name);
				if (!tool) throw new Error(`Tool ${call.toolCall.name} is unavailable during recovery`);
				let started: ToolStartedRecord | undefined = records.find(
					(record): record is ToolStartedRecord =>
						record.type === "tool_started" &&
						record.assistantEntryId === call.assistantEntryId &&
						record.toolIndex === call.toolIndex,
				);
				const replayingStartedTool = started !== undefined;
				if (!started) {
					const preparedArguments = tool.prepareArguments
						? tool.prepareArguments(call.toolCall.arguments)
						: call.toolCall.arguments;
					const effectiveArgs = validateToolArguments(tool, {
						...call.toolCall,
						arguments: preparedArguments as AgentToolCall["arguments"],
					});
					started = await this.session.appendRecord({
						type: "tool_started",
						id: uuidv7(),
						lane: "main",
						runId: operation.id,
						assistantEntryId: call.assistantEntryId,
						toolIndex: call.toolIndex,
						toolCallId: call.toolCall.id,
						toolName: call.toolCall.name,
						effectiveArgs: omitUndefinedProperties(effectiveArgs) as { [key: string]: unknown },
						resultEntryId: uuidv7(),
						replay: this.replayPolicy(call.toolCall.name),
					});
					await flushSession(this.session);
				}
				const reconciliation = replayingStartedTool
					? await this.reconcileStartedTool(operation.id, started)
					: { status: "not_started" as const };
				if (reconciliation.status === "unknown") {
					throw new PiAgentRecoveryError("outcome_unknown", `Cannot replay tool call ${started.toolCallId}`);
				}
				const result =
					reconciliation.status === "completed"
						? recoveredToolResult(started, reconciliation.result, reconciliation.isError ?? false)
						: await executeRecoveredTool(tool, started, this.recoveryAbortController.signal);
				const committed = await this.session.appendEntry(
					{ type: "message", id: started.resultEntryId, message: result },
					"main",
				);
				await this.appendUsage(operation.id, committed.id, result);
				await flushSession(this.session);
				this.agent.state.messages = [...this.agent.state.messages, result];
				await this.events.emit("message/committed", { entryId: committed.id, message: result });
			}
		} finally {
			this.recoveryAbortController = undefined;
		}
	}

	private async reconcileStartedTool(runId: string, started: ToolStartedRecord): Promise<ToolReconciliationOutcome> {
		if (started.replay === "safe") return { status: "not_started" };
		const cached = this.reconciledToolCalls.get(started.toolCallId);
		if (cached) return cached;
		if (!this.toolReconciliation) return { status: "unknown" };
		let outcome: ToolReconciliationOutcome;
		try {
			outcome = await this.toolReconciliation.service.reconcile({
				runId,
				toolCallId: started.toolCallId,
				toolName: started.toolName,
				effectiveArgs: structuredClone(started.effectiveArgs),
				resultEntryId: started.resultEntryId,
			});
		} catch (error) {
			outcome = { status: "unknown", reason: error instanceof Error ? error.message : String(error) };
		}
		this.reconciledToolCalls.set(started.toolCallId, outcome);
		return outcome;
	}

	private async restoreQueuedMessages(operation: OperationStartedRecord): Promise<void> {
		const records = await this.session.findRecords({ lane: "main", runId: operation.id, order: "oldestFirst" });
		if (records.some((record) => record.type === "abort_requested")) return;
		const [entries, cancellations] = await Promise.all([
			this.session.findEntries(),
			this.session.findRecords({ type: "queue_cancelled", runId: operation.id }),
		]);
		const committedIds = new Set(entries.map((entry) => entry.id));
		const cancelledIds = new Set(cancellations.map((record) => record.entryId));
		for (const record of records) {
			if (
				record.type !== "queue_enqueued" ||
				record.queue === "nextRun" ||
				record.target.type !== "message" ||
				committedIds.has(record.target.id) ||
				cancelledIds.has(record.target.id)
			) {
				continue;
			}
			const message = normalizeQueuedMessage(record.target.message);
			this.queuedEntryIds.set(message, record.target.id);
			this.pendingQueueEntries.set(record.target.id, {
				runId: operation.id,
				queue: record.queue,
				message,
			});
			if (record.queue === "steer") this.agent.steer(message);
			else this.agent.followUp(message);
		}
	}
}

function unresolvedToolCalls(
	entries: readonly Entry[],
): { assistantEntryId: string; toolIndex: number; toolCall: AgentToolCall }[] {
	const unresolved = new Map<string, { assistantEntryId: string; toolIndex: number; toolCall: AgentToolCall }>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "assistant") {
			const calls = entry.message.content.filter((part): part is AgentToolCall => part.type === "toolCall");
			for (const [toolIndex, toolCall] of calls.entries()) {
				unresolved.set(toolCall.id, { assistantEntryId: entry.id, toolIndex, toolCall });
			}
		} else if (entry.message.role === "toolResult") {
			unresolved.delete(entry.message.toolCallId);
		}
	}
	return [...unresolved.values()];
}

async function executeRecoveredTool(
	tool: AgentTool,
	started: ToolStartedRecord,
	signal: AbortSignal,
): Promise<ToolResultMessage> {
	let isError = false;
	let result: AgentToolResult<unknown>;
	try {
		result = await tool.execute(started.toolCallId, started.effectiveArgs as never, signal);
	} catch (error) {
		isError = true;
		result = {
			content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
			details: {},
		};
	}
	return recoveredToolResult(started, result, isError);
}

function recoveredToolResult(
	started: ToolStartedRecord,
	result: AgentToolResult<unknown>,
	isError: boolean,
): ToolResultMessage {
	return normalizeDurableMessage({
		role: "toolResult",
		toolCallId: started.toolCallId,
		toolName: started.toolName,
		content: result.content ?? [],
		details: result.details,
		usage: result.usage,
		...(result.addedToolNames?.length ? { addedToolNames: result.addedToolNames } : {}),
		isError,
		timestamp: Date.now(),
	}) as ToolResultMessage;
}

function validateRecoveryConfiguration(
	runId: string,
	data: unknown,
	current: RequestConfigurationAnchorV1,
): Extract<PiAgentRecoveryState, { status: "blocked" }> | undefined {
	if (!isRequestConfigurationAnchorV1(data) || data.runId !== runId) {
		return {
			status: "blocked",
			runId,
			code: "unsupported_operation",
			message: `Operation ${runId} has an invalid request configuration anchor`,
		};
	}
	if (
		data.systemPrompt !== current.systemPrompt ||
		data.model.provider !== current.model.provider ||
		data.model.id !== current.model.id ||
		data.thinkingLevel !== current.thinkingLevel ||
		data.reconciliationVersion !== current.reconciliationVersion ||
		stableJson(data.tools) !== stableJson(current.tools)
	) {
		return {
			status: "blocked",
			runId,
			code: "configuration_mismatch",
			message: `Operation ${runId} must resume with its original prompt, model, and tool configuration`,
		};
	}
}

function isRequestConfigurationAnchorV1(value: unknown): value is RequestConfigurationAnchorV1 {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	const model = candidate.model;
	return (
		candidate.schemaVersion === 1 &&
		typeof candidate.runId === "string" &&
		typeof candidate.systemPrompt === "string" &&
		model !== null &&
		typeof model === "object" &&
		typeof (model as Record<string, unknown>).provider === "string" &&
		typeof (model as Record<string, unknown>).id === "string" &&
		isThinkingLevel(candidate.thinkingLevel) &&
		(candidate.reconciliationVersion === undefined || typeof candidate.reconciliationVersion === "string") &&
		Array.isArray(candidate.tools) &&
		candidate.tools.every(isAnchoredTool)
	);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max"
	);
}

function isAnchoredTool(value: unknown): value is RequestConfigurationAnchorV1["tools"][number] {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.name === "string" &&
		typeof candidate.description === "string" &&
		(candidate.policyVersion === undefined || typeof candidate.policyVersion === "string") &&
		isJsonValue(candidate.parameters)
	);
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (typeof value !== "object") return false;
	return Object.values(value).every(isJsonValue);
}

function stableJson(value: JsonValue): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`)
		.join(",")}}`;
}

async function flushSession(session: Session): Promise<void> {
	const flush = (session as Session & { flush?: () => Promise<void> }).flush;
	if (flush) await flush.call(session);
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

function telemetryError(error: unknown): { name: string; message: string } {
	return error instanceof Error
		? { name: error.name, message: error.message }
		: { name: "Error", message: String(error) };
}
