import Type, { type Static } from "typebox";
import { ClientRequestIdSchema, CommandIdSchema, ThreadIdSchema } from "./branded-ids.ts";

const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const DeduplicationKeySchema = StrictObject({
	principalId: Type.String({ minLength: 1 }),
	threadId: ThreadIdSchema,
	method: Type.String({ minLength: 1 }),
	clientRequestId: ClientRequestIdSchema,
});
export type DeduplicationKey = Static<typeof DeduplicationKeySchema>;

export const CommandAdmissionReceiptSchema = StrictObject({
	commandId: CommandIdSchema,
	principalId: Type.String({ minLength: 1 }),
	threadId: ThreadIdSchema,
	method: Type.String({ minLength: 1 }),
	clientRequestId: ClientRequestIdSchema,
	payloadHash: Type.String({ minLength: 1 }),
	admittedAt: Type.Integer({ minimum: 0 }),
	status: Type.Union([Type.Literal("admitted"), Type.Literal("executing"), Type.Literal("settled")]),
});
export type CommandAdmissionReceipt = Static<typeof CommandAdmissionReceiptSchema>;

export const CommandResultReceiptSchema = StrictObject({
	commandId: CommandIdSchema,
	principalId: Type.String({ minLength: 1 }),
	threadId: ThreadIdSchema,
	method: Type.String({ minLength: 1 }),
	clientRequestId: ClientRequestIdSchema,
	payloadHash: Type.String({ minLength: 1 }),
	completedAt: Type.Integer({ minimum: 0 }),
	ok: Type.Boolean(),
	result: Type.Optional(Type.Unknown()),
	error: Type.Optional(
		StrictObject({
			code: Type.String({ minLength: 1 }),
			message: Type.String({ minLength: 1 }),
		}),
	),
});
export type CommandResultReceipt = Static<typeof CommandResultReceiptSchema>;

export function canonicalJsonStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJsonStringify(item)).join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const sortedKeys = Object.keys(obj).sort();
	const entries = sortedKeys.map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(obj[key])}`);
	return `{${entries.join(",")}}`;
}

const FNV_PRIME = 1099511628211n;
const FNV_OFFSET = 14695981039346656037n;
const MASK64 = 0xffffffffffffffffn;

export function computePayloadHash(payload: unknown): string {
	const canonical = canonicalJsonStringify(payload);
	let hash = FNV_OFFSET;
	for (let i = 0; i < canonical.length; i++) {
		hash ^= BigInt(canonical.charCodeAt(i));
		hash = (hash * FNV_PRIME) & MASK64;
	}
	return hash.toString(16).padStart(16, "0");
}

export function formatDeduplicationKey(key: DeduplicationKey): string {
	return `${key.principalId}::${key.threadId}::${key.method}::${key.clientRequestId}`;
}
