import type {
	AcceptedReceipt,
	CommandId,
	EventId,
	LaneId,
	OperationId,
	PersistedReceipt,
	PowerLossDurableReceipt,
	ProcessId,
	StepId,
	ThreadId,
	ToolAttemptId,
	ToolCallId,
	TurnId,
} from "@earendil-works/pi-protocol";
import type { Entry, LaneRecord } from "../../harness/session/types.ts";

export interface TurnFact {
	readonly factType: "turn";
	readonly turnId: TurnId;
	readonly status: "admitted" | "started" | "completed" | "interrupted" | "failed";
	readonly clientRequestId?: string;
	readonly controllerEpoch?: number;
	readonly error?: { readonly code: string; readonly message: string };
	readonly terminal?: boolean;
}

export interface StepFact {
	readonly factType: "step";
	readonly stepId: StepId;
	readonly turnId: TurnId;
	readonly stepIndex: number;
	readonly status: "started" | "completed" | "failed" | "interrupted";
	readonly model: string;
	readonly provider: string;
	readonly snapshotHash?: string;
}

export interface ModelAttemptFact {
	readonly factType: "model_attempt";
	readonly modelAttemptId: string;
	readonly turnId: TurnId;
	readonly stepId: StepId;
	readonly status: "prepared" | "dispatch_intent" | "response_started" | "completed" | "failed" | "outcome_unknown";
	readonly providerRequestId?: string;
	readonly promptTokens?: number;
	readonly completionTokens?: number;
	readonly error?: string;
}

export interface ToolAttemptFact {
	readonly factType: "tool_attempt";
	readonly toolAttemptId: ToolAttemptId;
	readonly toolCallId: ToolCallId;
	readonly turnId: TurnId;
	readonly toolName: string;
	readonly status:
		| "attempt_prepared"
		| "execution_dispatch_intent"
		| "execution_started"
		| "result"
		| "failed"
		| "denied"
		| "outcome_unknown";
	readonly inputHash?: string;
	readonly outputHash?: string;
	readonly blobUri?: string;
	readonly callIndex?: number;
	readonly error?: string;
}

export interface ApprovalFact {
	readonly factType: "approval";
	readonly requestId: string;
	readonly turnId: TurnId;
	readonly toolAttemptId: ToolAttemptId;
	readonly decision: "approved" | "rejected" | "expired" | "controller_lost";
	readonly fingerprint: string;
	readonly controllerEpoch: number;
}

export interface ProcessFact {
	readonly factType: "process";
	readonly processId: ProcessId;
	readonly threadId: ThreadId;
	readonly turnId?: TurnId;
	readonly status: "reserved" | "starting" | "running" | "exited" | "failed" | "killed" | "timed_out" | "unknown";
	readonly exitCode?: number;
	readonly signal?: string;
	readonly timedOut?: boolean;
	readonly aborted?: boolean;
	readonly sandboxDenied?: boolean;
}

export interface ConfigurationFact {
	readonly factType: "configuration";
	readonly profileId: string;
	readonly configVersion: number;
	readonly manifestHash: string;
}

export type RuntimeFact =
	| TurnFact
	| StepFact
	| ModelAttemptFact
	| ToolAttemptFact
	| ApprovalFact
	| ProcessFact
	| ConfigurationFact;

export type JournalRecord =
	| { readonly recordType: "entry"; readonly entry: Entry }
	| { readonly recordType: "lane"; readonly laneRecord: LaneRecord }
	| { readonly recordType: "runtime_fact"; readonly fact: RuntimeFact };

export interface JournalEnvelope<R extends JournalRecord = JournalRecord> {
	readonly schemaVersion: number;
	readonly eventId: EventId;
	readonly seq: number;
	readonly threadId: ThreadId;
	readonly lane?: LaneId;
	readonly operationId?: OperationId;
	readonly turnId?: TurnId;
	readonly stepId?: StepId;
	readonly commandId?: CommandId;
	readonly causationId?: string;
	readonly correlationId?: string;
	readonly timestamp: number;
	readonly record: R;
	readonly checksum: string;
}

export type JournalDraft<R extends JournalRecord = JournalRecord> = Omit<
	JournalEnvelope<R>,
	"eventId" | "seq" | "timestamp" | "checksum"
>;

export interface CheckpointRef {
	readonly checkpointSeq: number;
	readonly snapshotHash: string;
	readonly timestamp: number;
}

export interface JournalWriter {
	append(drafts: readonly JournalDraft[]): Promise<AcceptedReceipt>;
	persist(upToSeq?: number): Promise<PersistedReceipt>;
	flush(upToSeq?: number): Promise<PowerLossDurableReceipt>;
	checkpoint(): Promise<CheckpointRef>;
	shutdown(): Promise<void>;
	discard(): Promise<void>;
}

export interface ThreadJournalStore {
	open(threadId: ThreadId): Promise<JournalWriter>;
	load(threadId: ThreadId, afterSeq?: number): AsyncIterable<JournalEnvelope>;
}
