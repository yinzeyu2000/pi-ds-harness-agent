import Type, { type Static } from "typebox";
import {
	ControllerEpochSchema,
	EventIdSchema,
	ItemIdSchema,
	ProcessIdSchema,
	StepIdSchema,
	ThreadIdSchema,
	ToolAttemptIdSchema,
	ToolCallIdSchema,
	TurnIdSchema,
} from "./branded-ids.ts";
import { ControllerLeaseSchema } from "./controller.ts";

const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const ThreadDurableStatusSchema = Type.Union([
	Type.Literal("active"),
	Type.Literal("archived"),
	Type.Literal("deleted"),
]);
export type ThreadDurableStatus = Static<typeof ThreadDurableStatusSchema>;

export const ThreadResidencyStatusSchema = Type.Union([
	Type.Literal("not_loaded"),
	Type.Literal("starting"),
	Type.Literal("idle"),
	Type.Literal("active"),
	Type.Literal("stopping"),
	Type.Literal("failed"),
]);
export type ThreadResidencyStatus = Static<typeof ThreadResidencyStatusSchema>;

export const TurnPhaseSchema = Type.Union([
	Type.Literal("admitted"),
	Type.Literal("in_progress"),
	Type.Literal("completed"),
	Type.Literal("interrupted"),
	Type.Literal("failed"),
]);
export type TurnPhase = Static<typeof TurnPhaseSchema>;

export const ApprovalDecisionSchema = Type.Union([
	Type.Literal("approved"),
	Type.Literal("rejected"),
	Type.Literal("expired"),
	Type.Literal("controller_lost"),
]);
export type ApprovalDecision = Static<typeof ApprovalDecisionSchema>;

export const ApprovalRequestSnapshotSchema = StrictObject({
	requestId: Type.String({ minLength: 1 }),
	threadId: ThreadIdSchema,
	turnId: TurnIdSchema,
	toolAttemptId: ToolAttemptIdSchema,
	toolName: Type.String({ minLength: 1 }),
	fingerprint: Type.String({ minLength: 1 }),
	description: Type.String(),
	expiresAt: Type.Integer({ minimum: 0 }),
	controllerEpoch: ControllerEpochSchema,
	decision: Type.Optional(ApprovalDecisionSchema),
	resolvedAt: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type ApprovalRequestSnapshot = Static<typeof ApprovalRequestSnapshotSchema>;

export const ToolAttemptStatusSchema = Type.Union([
	Type.Literal("prepared"),
	Type.Literal("dispatch_intent"),
	Type.Literal("started"),
	Type.Literal("completed"),
	Type.Literal("denied"),
	Type.Literal("failed"),
	Type.Literal("outcome_unknown"),
]);
export type ToolAttemptStatus = Static<typeof ToolAttemptStatusSchema>;

export const ToolAttemptSnapshotSchema = StrictObject({
	toolAttemptId: ToolAttemptIdSchema,
	toolCallId: ToolCallIdSchema,
	toolName: Type.String({ minLength: 1 }),
	status: ToolAttemptStatusSchema,
	preparedAt: Type.Integer({ minimum: 0 }),
	startedAt: Type.Optional(Type.Integer({ minimum: 0 })),
	completedAt: Type.Optional(Type.Integer({ minimum: 0 })),
	output: Type.Optional(Type.Unknown()),
	error: Type.Optional(Type.String()),
});
export type ToolAttemptSnapshot = Static<typeof ToolAttemptSnapshotSchema>;

export const ProcessStatusSchema = Type.Union([
	Type.Literal("reserved"),
	Type.Literal("starting"),
	Type.Literal("running"),
	Type.Literal("exited"),
	Type.Literal("failed"),
	Type.Literal("killed"),
	Type.Literal("timed_out"),
	Type.Literal("unknown"),
]);
export type ProcessStatus = Static<typeof ProcessStatusSchema>;

export const ProcessOutcomeSchema = StrictObject({
	exitCode: Type.Optional(Type.Integer()),
	signal: Type.Optional(Type.String()),
	timedOut: Type.Boolean(),
	aborted: Type.Boolean(),
	sandboxDenied: Type.Boolean(),
	outputTruncated: Type.Boolean(),
	terminationFailed: Type.Boolean(),
});
export type ProcessOutcome = Static<typeof ProcessOutcomeSchema>;

export const ProcessSnapshotSchema = StrictObject({
	processId: ProcessIdSchema,
	threadId: ThreadIdSchema,
	turnId: Type.Optional(TurnIdSchema),
	status: ProcessStatusSchema,
	command: Type.String({ minLength: 1 }),
	args: Type.Array(Type.String()),
	cwd: Type.String(),
	outcome: Type.Optional(ProcessOutcomeSchema),
	startedAt: Type.Optional(Type.Integer({ minimum: 0 })),
	endedAt: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type ProcessSnapshot = Static<typeof ProcessSnapshotSchema>;

export const ItemTypeSchema = Type.Union([
	Type.Literal("user_message"),
	Type.Literal("assistant_message"),
	Type.Literal("tool_call"),
	Type.Literal("tool_result"),
	Type.Literal("notice"),
	Type.Literal("error"),
]);
export type ItemType = Static<typeof ItemTypeSchema>;

export const ItemSnapshotSchema = StrictObject({
	itemId: ItemIdSchema,
	threadId: ThreadIdSchema,
	turnId: TurnIdSchema,
	stepId: Type.Optional(StepIdSchema),
	type: ItemTypeSchema,
	content: Type.Unknown(),
	createdAt: Type.Integer({ minimum: 0 }),
	completedAt: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type ItemSnapshot = Static<typeof ItemSnapshotSchema>;

export const StepSnapshotSchema = StrictObject({
	stepId: StepIdSchema,
	threadId: ThreadIdSchema,
	turnId: TurnIdSchema,
	stepIndex: Type.Integer({ minimum: 0 }),
	model: Type.String({ minLength: 1 }),
	provider: Type.String({ minLength: 1 }),
	startedAt: Type.Integer({ minimum: 0 }),
	completedAt: Type.Optional(Type.Integer({ minimum: 0 })),
	inputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
	outputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type StepSnapshot = Static<typeof StepSnapshotSchema>;

export const TurnSnapshotSchema = StrictObject({
	turnId: TurnIdSchema,
	threadId: ThreadIdSchema,
	phase: TurnPhaseSchema,
	admittedAt: Type.Integer({ minimum: 0 }),
	startedAt: Type.Optional(Type.Integer({ minimum: 0 })),
	completedAt: Type.Optional(Type.Integer({ minimum: 0 })),
	activeFlags: StrictObject({
		waitingOnApproval: Type.Boolean(),
		waitingOnUserInput: Type.Boolean(),
		cancellationRequested: Type.Boolean(),
		runningTasksCount: Type.Integer({ minimum: 0 }),
	}),
	pendingApprovals: Type.Array(ApprovalRequestSnapshotSchema),
	error: Type.Optional(
		StrictObject({
			code: Type.String({ minLength: 1 }),
			message: Type.String({ minLength: 1 }),
		}),
	),
});
export type TurnSnapshot = Static<typeof TurnSnapshotSchema>;

export const ThreadSnapshotSchema = StrictObject({
	threadId: ThreadIdSchema,
	durableStatus: ThreadDurableStatusSchema,
	residencyStatus: ThreadResidencyStatusSchema,
	runtimeGeneration: Type.Optional(Type.Integer({ minimum: 1 })),
	activeController: Type.Optional(ControllerLeaseSchema),
	activeTurn: Type.Optional(TurnSnapshotSchema),
	createdAt: Type.Integer({ minimum: 0 }),
	updatedAt: Type.Integer({ minimum: 0 }),
	durableWatermarkSeq: Type.Integer({ minimum: 0 }),
});
export type ThreadSnapshot = Static<typeof ThreadSnapshotSchema>;

export const WireEventTypeSchema = Type.Union([
	Type.Literal("thread.started"),
	Type.Literal("thread.residency_changed"),
	Type.Literal("turn.admitted"),
	Type.Literal("turn.started"),
	Type.Literal("step.started"),
	Type.Literal("step.completed"),
	Type.Literal("item.started"),
	Type.Literal("item.completed"),
	Type.Literal("tool_attempt.started"),
	Type.Literal("tool_attempt.completed"),
	Type.Literal("approval.requested"),
	Type.Literal("approval.resolved"),
	Type.Literal("process.started"),
	Type.Literal("process.ended"),
	Type.Literal("turn.completed"),
	Type.Literal("turn.interrupted"),
	Type.Literal("turn.failed"),
]);
export type WireEventType = Static<typeof WireEventTypeSchema>;

export const WireEventEnvelopeSchema = StrictObject({
	eventId: EventIdSchema,
	threadId: ThreadIdSchema,
	seq: Type.Integer({ minimum: 1 }),
	type: WireEventTypeSchema,
	payload: Type.Unknown(),
	timestamp: Type.Integer({ minimum: 0 }),
});
export type WireEventEnvelope = Static<typeof WireEventEnvelopeSchema>;

export const LiveEventTypeSchema = Type.Union([
	Type.Literal("item.delta"),
	Type.Literal("tool.progress"),
	Type.Literal("process.output"),
	Type.Literal("live_gap"),
]);
export type LiveEventType = Static<typeof LiveEventTypeSchema>;

export const LiveEventEnvelopeSchema = StrictObject({
	threadId: ThreadIdSchema,
	type: LiveEventTypeSchema,
	cursorSeq: Type.Integer({ minimum: 0 }),
	payload: Type.Unknown(),
	timestamp: Type.Integer({ minimum: 0 }),
});
export type LiveEventEnvelope = Static<typeof LiveEventEnvelopeSchema>;
