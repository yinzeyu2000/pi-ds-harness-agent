import type { StepId, ToolAttemptId, ToolCallId, TurnId } from "@earendil-works/pi-protocol";

export type ActionKind = "fs_read" | "fs_write" | "fs_edit" | "fs_delete" | "network" | "process" | "compute";

export interface PreparedAction {
	readonly kind: ActionKind;
	readonly toolName: string;
	readonly payload: unknown;
	readonly paths?: readonly string[];
	readonly networkHosts?: readonly string[];
	readonly requiresApproval?: boolean;
	readonly approvalFingerprint?: string;
}

export interface ToolExecutionContext {
	readonly toolAttemptId: ToolAttemptId;
	readonly toolCallId: ToolCallId;
	readonly turnId: TurnId;
	readonly stepId: StepId;
	readonly signal: AbortSignal;
}

export interface ToolExecutionOutcome {
	readonly toolAttemptId: ToolAttemptId;
	readonly status: "completed" | "denied" | "failed" | "outcome_unknown";
	readonly output?: unknown;
	readonly error?: string;
	readonly durationMs: number;
}

export interface ExecutionBroker {
	prepareAction(toolName: string, input: unknown, context: ToolExecutionContext): Promise<PreparedAction>;
	executeAction(action: PreparedAction, context: ToolExecutionContext): Promise<ToolExecutionOutcome>;
}

export interface ToolAttemptCoordinator {
	onAttemptPrepared(toolAttemptId: ToolAttemptId, action: PreparedAction): Promise<void>;
	onDispatchIntent(toolAttemptId: ToolAttemptId): Promise<void>;
	onExecutionStarted(toolAttemptId: ToolAttemptId): Promise<void>;
	onAttemptSettled(toolAttemptId: ToolAttemptId, outcome: ToolExecutionOutcome): Promise<void>;
}
