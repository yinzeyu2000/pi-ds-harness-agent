import Type, { type Static } from "typebox";
import { ControllerEpochSchema, ThreadIdSchema } from "./branded-ids.ts";

const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const ControllerLeaseSchema = StrictObject({
	threadId: ThreadIdSchema,
	controllerId: Type.String({ minLength: 1 }),
	epoch: ControllerEpochSchema,
	acquiredAt: Type.Integer({ minimum: 0 }),
	expiresAt: Type.Integer({ minimum: 0 }),
});
export type ControllerLease = Static<typeof ControllerLeaseSchema>;

export const AcquireControllerCommandSchema = StrictObject({
	command: Type.Literal("controller/acquire"),
	threadId: ThreadIdSchema,
	controllerId: Type.String({ minLength: 1 }),
	ttlMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 300000 })),
});
export type AcquireControllerCommand = Static<typeof AcquireControllerCommandSchema>;

export const AcquireControllerResultSchema = StrictObject({
	command: Type.Literal("controller/acquire"),
	lease: ControllerLeaseSchema,
});
export type AcquireControllerResult = Static<typeof AcquireControllerResultSchema>;

export const ReleaseControllerCommandSchema = StrictObject({
	command: Type.Literal("controller/release"),
	threadId: ThreadIdSchema,
	controllerId: Type.String({ minLength: 1 }),
	epoch: ControllerEpochSchema,
});
export type ReleaseControllerCommand = Static<typeof ReleaseControllerCommandSchema>;

export const ReleaseControllerResultSchema = StrictObject({
	command: Type.Literal("controller/release"),
	released: Type.Boolean(),
	epoch: ControllerEpochSchema,
});
export type ReleaseControllerResult = Static<typeof ReleaseControllerResultSchema>;

export function isControllerEpochValid(
	activeLease: ControllerLease | null | undefined,
	requiredEpoch: number,
	controllerId?: string,
): boolean {
	if (!activeLease) return false;
	if (activeLease.epoch !== requiredEpoch) return false;
	if (controllerId !== undefined && activeLease.controllerId !== controllerId) return false;
	if (Date.now() > activeLease.expiresAt) return false;
	return true;
}
