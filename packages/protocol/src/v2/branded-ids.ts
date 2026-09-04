import Type from "typebox";

declare const brandSymbol: unique symbol;

export type Branded<T, B extends string> = T & { readonly [brandSymbol]: B };

export type ThreadId = Branded<string, "ThreadId">;
export type LaneId = Branded<string, "LaneId">;
export type OperationId = Branded<string, "OperationId">;
export type TurnId = Branded<string, "TurnId">;
export type StepId = Branded<string, "StepId">;
export type TaskId = Branded<string, "TaskId">;
export type ItemId = Branded<string, "ItemId">;
export type ToolCallId = Branded<string, "ToolCallId">;
export type ToolAttemptId = Branded<string, "ToolAttemptId">;
export type ProcessId = Branded<string, "ProcessId">;
export type CommandId = Branded<string, "CommandId">;
export type ClientRequestId = Branded<string, "ClientRequestId">;
export type EventId = Branded<string, "EventId">;
export type CausationId = Branded<string, "CausationId">;
export type CorrelationId = Branded<string, "CorrelationId">;
export type TraceId = Branded<string, "TraceId">;

export type RuntimeGeneration = Branded<number, "RuntimeGeneration">;
export type ControllerEpoch = Branded<number, "ControllerEpoch">;

export const ThreadIdSchema = Type.String({ minLength: 1, description: "Durable thread identity" });
export const LaneIdSchema = Type.String({ minLength: 1, description: "History lane identity" });
export const OperationIdSchema = Type.String({ minLength: 1, description: "Operation identity" });
export const TurnIdSchema = Type.String({ minLength: 1, description: "Turn identity" });
export const StepIdSchema = Type.String({ minLength: 1, description: "Step reasoning-loop identity" });
export const TaskIdSchema = Type.String({ minLength: 1, description: "Asynchronous task identity" });
export const ItemIdSchema = Type.String({ minLength: 1, description: "Transcript/UI item identity" });
export const ToolCallIdSchema = Type.String({ minLength: 1, description: "Model tool call identity" });
export const ToolAttemptIdSchema = Type.String({ minLength: 1, description: "Tool dispatch attempt identity" });
export const ProcessIdSchema = Type.String({ minLength: 1, description: "Supervised logical process identity" });
export const CommandIdSchema = Type.String({ minLength: 1, description: "Admitted command identity" });
export const ClientRequestIdSchema = Type.String({ minLength: 1, description: "Client deduplication identity" });
export const EventIdSchema = Type.String({ minLength: 1, description: "Durable event identity" });
export const CausationIdSchema = Type.String({ minLength: 1, description: "Causal origin identity" });
export const CorrelationIdSchema = Type.String({ minLength: 1, description: "Trace correlation identity" });
export const TraceIdSchema = Type.String({ minLength: 1, description: "Distributed trace identity" });

export const RuntimeGenerationSchema = Type.Integer({ minimum: 1, description: "Monotonic runtime generation" });
export const ControllerEpochSchema = Type.Integer({ minimum: 0, description: "Monotonic controller lease epoch" });

export function asThreadId(value: string): ThreadId {
	if (!value || typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError("ThreadId must be a non-empty string");
	}
	return value as ThreadId;
}

export function asLaneId(value: string): LaneId {
	if (!value || typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError("LaneId must be a non-empty string");
	}
	return value as LaneId;
}

export function asOperationId(value: string): OperationId {
	if (!value || typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError("OperationId must be a non-empty string");
	}
	return value as OperationId;
}

export function asTurnId(value: string): TurnId {
	if (!value || typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError("TurnId must be a non-empty string");
	}
	return value as TurnId;
}

export function asStepId(value: string): StepId {
	if (!value || typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError("StepId must be a non-empty string");
	}
	return value as StepId;
}

export function asTaskId(value: string): TaskId {
	if (!value || typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError("TaskId must be a non-empty string");
	}
	return value as TaskId;
}

export function asItemId(value: string): ItemId {
	if (!value || typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError("ItemId must be a non-empty string");
	}
	return value as ItemId;
}

export function asToolCallId(value: string): ToolCallId {
	if (!value || typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError("ToolCallId must be a non-empty string");
	}
	return value as ToolCallId;
}

export function asToolAttemptId(value: string): ToolAttemptId {
	if (!value || typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError("ToolAttemptId must be a non-empty string");
	}
	return value as ToolAttemptId;
}

export function asProcessId(value: string): ProcessId {
	if (!value || typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError("ProcessId must be a non-empty string");
	}
	return value as ProcessId;
}

export function asCommandId(value: string): CommandId {
	if (!value || typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError("CommandId must be a non-empty string");
	}
	return value as CommandId;
}

export function asClientRequestId(value: string): ClientRequestId {
	if (!value || typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError("ClientRequestId must be a non-empty string");
	}
	return value as ClientRequestId;
}

export function asEventId(value: string): EventId {
	if (!value || typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError("EventId must be a non-empty string");
	}
	return value as EventId;
}

export function asCausationId(value: string): CausationId {
	if (!value || typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError("CausationId must be a non-empty string");
	}
	return value as CausationId;
}

export function asCorrelationId(value: string): CorrelationId {
	if (!value || typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError("CorrelationId must be a non-empty string");
	}
	return value as CorrelationId;
}

export function asTraceId(value: string): TraceId {
	if (!value || typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError("TraceId must be a non-empty string");
	}
	return value as TraceId;
}

export function asRuntimeGeneration(value: number): RuntimeGeneration {
	if (!Number.isInteger(value) || value < 1) {
		throw new TypeError("RuntimeGeneration must be an integer >= 1");
	}
	return value as RuntimeGeneration;
}

export function asControllerEpoch(value: number): ControllerEpoch {
	if (!Number.isInteger(value) || value < 0) {
		throw new TypeError("ControllerEpoch must be an integer >= 0");
	}
	return value as ControllerEpoch;
}
