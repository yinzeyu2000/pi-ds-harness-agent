import Type, { type Static } from "typebox";
import {
	ClientRequestIdSchema,
	CommandIdSchema,
	ControllerEpochSchema,
	ThreadIdSchema,
	TurnIdSchema,
} from "./branded-ids.ts";
import {
	ClientHelloV2Schema,
	HandshakeErrorV2Schema,
	InitializedNotificationV2Schema,
	ServerHelloV2Schema,
} from "./capabilities.ts";
import {
	AcquireControllerCommandSchema,
	AcquireControllerResultSchema,
	ReleaseControllerCommandSchema,
	ReleaseControllerResultSchema,
} from "./controller.ts";
import {
	ApprovalDecisionSchema,
	LiveEventEnvelopeSchema,
	ThreadSnapshotSchema,
	WireEventEnvelopeSchema,
} from "./wire-types.ts";

const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const TurnStartCommandSchema = StrictObject({
	command: Type.Literal("turn/start"),
	threadId: ThreadIdSchema,
	input: Type.Unknown(),
	clientRequestId: ClientRequestIdSchema,
	controllerEpoch: ControllerEpochSchema,
});
export type TurnStartCommand = Static<typeof TurnStartCommandSchema>;

export const TurnStartResultSchema = StrictObject({
	command: Type.Literal("turn/start"),
	status: Type.Literal("admitted"),
	turnId: TurnIdSchema,
	admittedAt: Type.Integer({ minimum: 0 }),
});
export type TurnStartResult = Static<typeof TurnStartResultSchema>;

export const TurnSteerCommandSchema = StrictObject({
	command: Type.Literal("turn/steer"),
	threadId: ThreadIdSchema,
	turnId: TurnIdSchema,
	input: Type.Unknown(),
	clientRequestId: ClientRequestIdSchema,
	controllerEpoch: ControllerEpochSchema,
});
export type TurnSteerCommand = Static<typeof TurnSteerCommandSchema>;

export const TurnSteerResultSchema = StrictObject({
	command: Type.Literal("turn/steer"),
	status: Type.Literal("steered"),
	turnId: TurnIdSchema,
});
export type TurnSteerResult = Static<typeof TurnSteerResultSchema>;

export const TurnInterruptCommandSchema = StrictObject({
	command: Type.Literal("turn/interrupt"),
	threadId: ThreadIdSchema,
	turnId: TurnIdSchema,
	clientRequestId: ClientRequestIdSchema,
	controllerEpoch: ControllerEpochSchema,
});
export type TurnInterruptCommand = Static<typeof TurnInterruptCommandSchema>;

export const TurnInterruptResultSchema = StrictObject({
	command: Type.Literal("turn/interrupt"),
	status: Type.Literal("interrupting"),
	turnId: TurnIdSchema,
});
export type TurnInterruptResult = Static<typeof TurnInterruptResultSchema>;

export const ApprovalRespondCommandSchema = StrictObject({
	command: Type.Literal("approval/respond"),
	threadId: ThreadIdSchema,
	turnId: TurnIdSchema,
	requestId: Type.String({ minLength: 1 }),
	decision: ApprovalDecisionSchema,
	clientRequestId: ClientRequestIdSchema,
	controllerEpoch: ControllerEpochSchema,
});
export type ApprovalRespondCommand = Static<typeof ApprovalRespondCommandSchema>;

export const ApprovalRespondResultSchema = StrictObject({
	command: Type.Literal("approval/respond"),
	status: Type.Literal("resolved"),
	requestId: Type.String({ minLength: 1 }),
	decision: ApprovalDecisionSchema,
});
export type ApprovalRespondResult = Static<typeof ApprovalRespondResultSchema>;

export const ThreadWatchCommandSchema = StrictObject({
	command: Type.Literal("thread/watch"),
	threadId: ThreadIdSchema,
	afterSeq: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type ThreadWatchCommand = Static<typeof ThreadWatchCommandSchema>;

export const ThreadWatchResultSchema = StrictObject({
	command: Type.Literal("thread/watch"),
	threadId: ThreadIdSchema,
	snapshot: ThreadSnapshotSchema,
	durableWatermarkSeq: Type.Integer({ minimum: 0 }),
});
export type ThreadWatchResult = Static<typeof ThreadWatchResultSchema>;

export const ProtocolV2CommandSchema = Type.Union([
	AcquireControllerCommandSchema,
	ReleaseControllerCommandSchema,
	TurnStartCommandSchema,
	TurnSteerCommandSchema,
	TurnInterruptCommandSchema,
	ApprovalRespondCommandSchema,
	ThreadWatchCommandSchema,
]);
export type ProtocolV2Command = Static<typeof ProtocolV2CommandSchema>;

export const ProtocolV2CommandResultSchema = Type.Union([
	AcquireControllerResultSchema,
	ReleaseControllerResultSchema,
	TurnStartResultSchema,
	TurnSteerResultSchema,
	TurnInterruptResultSchema,
	ApprovalRespondResultSchema,
	ThreadWatchResultSchema,
]);
export type ProtocolV2CommandResult = Static<typeof ProtocolV2CommandResultSchema>;

export const ProtocolV2ErrorSchema = StrictObject({
	code: Type.String({ minLength: 1 }),
	message: Type.String({ minLength: 1 }),
	details: Type.Optional(Type.Unknown()),
});
export type ProtocolV2Error = Static<typeof ProtocolV2ErrorSchema>;

export const ProtocolV2RequestEnvelopeSchema = StrictObject({
	type: Type.Literal("request"),
	id: CommandIdSchema,
	request: ProtocolV2CommandSchema,
});
export type ProtocolV2RequestEnvelope = Static<typeof ProtocolV2RequestEnvelopeSchema>;

export const ProtocolV2ResponseEnvelopeSchema = Type.Union([
	StrictObject({
		type: Type.Literal("response"),
		id: CommandIdSchema,
		ok: Type.Literal(true),
		result: ProtocolV2CommandResultSchema,
	}),
	StrictObject({
		type: Type.Literal("response"),
		id: CommandIdSchema,
		ok: Type.Literal(false),
		error: ProtocolV2ErrorSchema,
	}),
]);
export type ProtocolV2ResponseEnvelope = Static<typeof ProtocolV2ResponseEnvelopeSchema>;

export const ProtocolV2ServerEventEnvelopeSchema = StrictObject({
	type: Type.Literal("event"),
	event: WireEventEnvelopeSchema,
});
export type ProtocolV2ServerEventEnvelope = Static<typeof ProtocolV2ServerEventEnvelopeSchema>;

export const ProtocolV2LiveEventEnvelopeSchema = StrictObject({
	type: Type.Literal("live"),
	event: LiveEventEnvelopeSchema,
});
export type ProtocolV2LiveEventEnvelope = Static<typeof ProtocolV2LiveEventEnvelopeSchema>;

export const ClientMessageV2Schema = Type.Union([
	ClientHelloV2Schema,
	InitializedNotificationV2Schema,
	ProtocolV2RequestEnvelopeSchema,
]);
export type ClientMessageV2 = Static<typeof ClientMessageV2Schema>;

export const ServerMessageV2Schema = Type.Union([
	ServerHelloV2Schema,
	HandshakeErrorV2Schema,
	ProtocolV2ResponseEnvelopeSchema,
	ProtocolV2ServerEventEnvelopeSchema,
	ProtocolV2LiveEventEnvelopeSchema,
]);
export type ServerMessageV2 = Static<typeof ServerMessageV2Schema>;
