import Type, { type Static } from "typebox";
import { EventIdSchema, ThreadIdSchema } from "./branded-ids.ts";

const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const DurabilityLevelSchema = Type.Union([
	Type.Literal("accepted"),
	Type.Literal("persisted"),
	Type.Literal("power_loss_durable"),
]);
export type DurabilityLevel = Static<typeof DurabilityLevelSchema>;

export const AcceptedReceiptSchema = StrictObject({
	level: Type.Literal("accepted"),
	threadId: ThreadIdSchema,
	eventId: EventIdSchema,
	seq: Type.Integer({ minimum: 1 }),
	timestamp: Type.Integer({ minimum: 0 }),
});
export type AcceptedReceipt = Static<typeof AcceptedReceiptSchema>;

export const PersistedReceiptSchema = StrictObject({
	level: Type.Literal("persisted"),
	threadId: ThreadIdSchema,
	watermarkSeq: Type.Integer({ minimum: 1 }),
	persistedAt: Type.Integer({ minimum: 0 }),
});
export type PersistedReceipt = Static<typeof PersistedReceiptSchema>;

export const PowerLossDurableReceiptSchema = StrictObject({
	level: Type.Literal("power_loss_durable"),
	threadId: ThreadIdSchema,
	durableSeq: Type.Integer({ minimum: 1 }),
	syncedAt: Type.Integer({ minimum: 0 }),
});
export type PowerLossDurableReceipt = Static<typeof PowerLossDurableReceiptSchema>;

export const DurabilityReceiptSchema = Type.Union([
	AcceptedReceiptSchema,
	PersistedReceiptSchema,
	PowerLossDurableReceiptSchema,
]);
export type DurabilityReceipt = Static<typeof DurabilityReceiptSchema>;

export const DurableCursorSchema = StrictObject({
	threadId: ThreadIdSchema,
	afterSeq: Type.Integer({ minimum: 0 }),
	durableWatermark: Type.Integer({ minimum: 0 }),
});
export type DurableCursor = Static<typeof DurableCursorSchema>;

export const LiveCursorSchema = StrictObject({
	threadId: ThreadIdSchema,
	connectionId: Type.String({ minLength: 1 }),
	epoch: Type.Integer({ minimum: 0 }),
	cursorSeq: Type.Integer({ minimum: 0 }),
});
export type LiveCursor = Static<typeof LiveCursorSchema>;
