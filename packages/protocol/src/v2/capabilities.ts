import Type, { type Static } from "typebox";

const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const PROTOCOL_V2_VERSION = 2 as const;

export const ClientInfoSchema = StrictObject({
	name: Type.String({ minLength: 1 }),
	version: Type.String({ minLength: 1 }),
	uiType: Type.Optional(
		Type.Union([Type.Literal("cli"), Type.Literal("tui"), Type.Literal("gui"), Type.Literal("headless")]),
	),
});
export type ClientInfo = Static<typeof ClientInfoSchema>;

export const ClientCapabilitiesSchema = StrictObject({
	streamingDeltas: Type.Boolean(),
	approvalPrompts: Type.Boolean(),
	controllerLease: Type.Boolean(),
	binaryFrames: Type.Boolean(),
	processInteractivePty: Type.Boolean(),
	experimental: Type.Optional(Type.Record(Type.String(), Type.Boolean())),
});
export type ClientCapabilities = Static<typeof ClientCapabilitiesSchema>;

export const ServerCapabilitiesSchema = StrictObject({
	protocolVersion: Type.Literal(PROTOCOL_V2_VERSION),
	fencedControllers: Type.Boolean(),
	commandDeduplication: Type.Boolean(),
	durableReplay: Type.Boolean(),
	liveGapsNotice: Type.Boolean(),
	sandboxing: Type.Boolean(),
	maxPayloadBytes: Type.Integer({ minimum: 1024 }),
	experimental: Type.Optional(Type.Record(Type.String(), Type.Boolean())),
});
export type ServerCapabilities = Static<typeof ServerCapabilitiesSchema>;

export const ClientHelloV2Schema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Literal(PROTOCOL_V2_VERSION),
	clientInfo: ClientInfoSchema,
	capabilities: ClientCapabilitiesSchema,
});
export type ClientHelloV2 = Static<typeof ClientHelloV2Schema>;

export const InitializedNotificationV2Schema = StrictObject({
	type: Type.Literal("initialized"),
	protocolVersion: Type.Literal(PROTOCOL_V2_VERSION),
});
export type InitializedNotificationV2 = Static<typeof InitializedNotificationV2Schema>;

export const ServerHelloV2Schema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Literal(PROTOCOL_V2_VERSION),
	connectionId: Type.String({ minLength: 1 }),
	serverCapabilities: ServerCapabilitiesSchema,
});
export type ServerHelloV2 = Static<typeof ServerHelloV2Schema>;

export const HandshakeErrorV2Schema = StrictObject({
	type: Type.Literal("hello_error"),
	protocolVersion: Type.Integer({ minimum: 1 }),
	code: Type.String({ minLength: 1 }),
	message: Type.String({ minLength: 1 }),
});
export type HandshakeErrorV2 = Static<typeof HandshakeErrorV2Schema>;
