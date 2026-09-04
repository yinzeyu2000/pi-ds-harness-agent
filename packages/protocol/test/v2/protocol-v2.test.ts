import { describe, expect, test } from "vitest";
import {
	asClientRequestId,
	asCommandId,
	asControllerEpoch,
	asThreadId,
	asTurnId,
	computePayloadHash,
	formatDeduplicationKey,
	isControllerEpochValid,
	PROTOCOL_V2_VERSION,
	v2,
} from "../../src/index.ts";

describe("Protocol v2", () => {
	test("handshake capabilities and version 2", () => {
		expect(PROTOCOL_V2_VERSION).toBe(2);

		const clientHello: v2.ClientHelloV2 = {
			type: "hello",
			version: 2,
			clientInfo: {
				name: "test-client",
				version: "1.0.0",
				uiType: "tui",
			},
			capabilities: {
				streamingDeltas: true,
				approvalPrompts: true,
				controllerLease: true,
				binaryFrames: false,
				processInteractivePty: false,
			},
		};

		expect(clientHello.version).toBe(2);
		expect(clientHello.capabilities.controllerLease).toBe(true);
	});

	test("controller lease fencing and epoch validation", () => {
		const threadId = asThreadId("th_001");
		const epoch0 = asControllerEpoch(0);
		const epoch1 = asControllerEpoch(1);

		const lease: v2.ControllerLease = {
			threadId,
			controllerId: "ctrl-agent-1",
			epoch: epoch1,
			acquiredAt: Date.now(),
			expiresAt: Date.now() + 60000,
		};

		// Current epoch match -> valid
		expect(isControllerEpochValid(lease, epoch1, "ctrl-agent-1")).toBe(true);

		// Stale epoch mismatch -> invalid
		expect(isControllerEpochValid(lease, epoch0, "ctrl-agent-1")).toBe(false);

		// Different controllerId -> invalid
		expect(isControllerEpochValid(lease, epoch1, "ctrl-agent-2")).toBe(false);

		// Expired lease -> invalid
		const expiredLease: v2.ControllerLease = {
			...lease,
			expiresAt: Date.now() - 1000,
		};
		expect(isControllerEpochValid(expiredLease, 1, "ctrl-agent-1")).toBe(false);
	});

	test("command deduplication key and payload hash matching", () => {
		const threadId = asThreadId("th_123");
		const clientReqId = asClientRequestId("req_abc");
		const commandId = asCommandId("cmd_001");

		const payloadA = { prompt: "run tests", timeout: 5000 };
		const payloadB = { timeout: 5000, prompt: "run tests" }; // Keys reversed, same content
		const payloadC = { prompt: "different prompt", timeout: 5000 };

		const hashA = computePayloadHash(payloadA);
		const hashB = computePayloadHash(payloadB);
		const hashC = computePayloadHash(payloadC);

		// Canonical JSON stringification ensures key order independence
		expect(hashA).toBe(hashB);
		expect(hashA).not.toBe(hashC);

		const dedupeKey: v2.DeduplicationKey = {
			principalId: "user-1",
			threadId,
			method: "turn/start",
			clientRequestId: clientReqId,
		};

		expect(formatDeduplicationKey(dedupeKey)).toBe("user-1::th_123::turn/start::req_abc");

		const receipt: v2.CommandAdmissionReceipt = {
			commandId,
			principalId: dedupeKey.principalId,
			threadId: dedupeKey.threadId,
			method: dedupeKey.method,
			clientRequestId: dedupeKey.clientRequestId,
			payloadHash: hashA,
			admittedAt: 1000,
			status: "admitted",
		};

		expect(receipt.payloadHash).toBe(hashB);
	});

	test("durability receipts hierarchy", () => {
		const threadId = asThreadId("th_test");

		const accepted: v2.AcceptedReceipt = {
			level: "accepted",
			threadId,
			eventId: v2.asEventId("evt_1"),
			seq: 1,
			timestamp: 1000,
		};

		const persisted: v2.PersistedReceipt = {
			level: "persisted",
			threadId,
			watermarkSeq: 1,
			persistedAt: 1050,
		};

		const durable: v2.PowerLossDurableReceipt = {
			level: "power_loss_durable",
			threadId,
			durableSeq: 1,
			syncedAt: 1100,
		};

		expect(accepted.level).toBe("accepted");
		expect(persisted.level).toBe("persisted");
		expect(durable.level).toBe("power_loss_durable");
		expect(durable.syncedAt).toBeGreaterThanOrEqual(persisted.persistedAt);
	});

	test("turn start and interrupt commands envelope structure", () => {
		const threadId = asThreadId("th_abc");
		const turnId = asTurnId("turn_001");
		const clientReqId = asClientRequestId("req_001");
		const epoch = asControllerEpoch(1);

		const turnStart: v2.TurnStartCommand = {
			command: "turn/start",
			threadId,
			input: { text: "Hello" },
			clientRequestId: clientReqId,
			controllerEpoch: epoch,
		};

		const turnInterrupt: v2.TurnInterruptCommand = {
			command: "turn/interrupt",
			threadId,
			turnId,
			clientRequestId: asClientRequestId("req_002"),
			controllerEpoch: epoch,
		};

		expect(turnStart.command).toBe("turn/start");
		expect(turnInterrupt.command).toBe("turn/interrupt");
		expect(turnInterrupt.turnId).toBe(turnId);
	});
});
