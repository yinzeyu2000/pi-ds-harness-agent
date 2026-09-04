import { describe, expect, test } from "vitest";
import {
	asClientRequestId,
	asCommandId,
	asControllerEpoch,
	asEventId,
	asThreadId,
	asTurnId,
	type v2,
} from "../../src/index.ts";

describe("Protocol v2 Fixtures Stability", () => {
	test("produces deterministic serialization for thread snapshot", () => {
		const threadId = asThreadId("th_fixed_001");
		const epoch = asControllerEpoch(1);
		const turnId = asTurnId("turn_fixed_001");

		const snapshot: v2.ThreadSnapshot = {
			threadId,
			durableStatus: "active",
			residencyStatus: "active",
			runtimeGeneration: 1,
			activeController: {
				threadId,
				controllerId: "ctrl-1",
				epoch,
				acquiredAt: 1700000000000,
				expiresAt: 1700000060000,
			},
			activeTurn: {
				turnId,
				threadId,
				phase: "in_progress",
				admittedAt: 1700000001000,
				activeFlags: {
					waitingOnApproval: false,
					waitingOnUserInput: false,
					cancellationRequested: false,
					runningTasksCount: 1,
				},
				pendingApprovals: [],
			},
			createdAt: 1700000000000,
			updatedAt: 1700000001000,
			durableWatermarkSeq: 42,
		};

		const serialized = JSON.stringify(snapshot);
		const parsed = JSON.parse(serialized);

		expect(parsed.threadId).toBe("th_fixed_001");
		expect(parsed.activeTurn.turnId).toBe("turn_fixed_001");
		expect(parsed.durableWatermarkSeq).toBe(42);
		expect(parsed.activeTurn.phase).toBe("in_progress");
	});

	test("produces deterministic wire event envelopes", () => {
		const threadId = asThreadId("th_evt_001");
		const eventId = asEventId("evt_seq_1");

		const wireEnvelope: v2.WireEventEnvelope = {
			eventId,
			threadId,
			seq: 1,
			type: "turn.admitted",
			payload: {
				turnId: "turn_1",
				clientRequestId: "req_1",
			},
			timestamp: 1700000000000,
		};

		const raw = JSON.stringify(wireEnvelope);
		const restored = JSON.parse(raw) as v2.WireEventEnvelope;

		expect(restored.type).toBe("turn.admitted");
		expect(restored.seq).toBe(1);
		expect(restored.eventId).toBe("evt_seq_1");
	});

	test("request and response envelope roundtrip", () => {
		const commandId = asCommandId("cmd_test_001");
		const threadId = asThreadId("th_turn_001");
		const clientReqId = asClientRequestId("req_turn_001");
		const epoch = asControllerEpoch(2);

		const request: v2.ProtocolV2RequestEnvelope = {
			type: "request",
			id: commandId,
			request: {
				command: "turn/start",
				threadId,
				input: { text: "write code" },
				clientRequestId: clientReqId,
				controllerEpoch: epoch,
			},
		};

		const response: v2.ProtocolV2ResponseEnvelope = {
			type: "response",
			id: commandId,
			ok: true,
			result: {
				command: "turn/start",
				status: "admitted",
				turnId: asTurnId("turn_new_001"),
				admittedAt: 1700000002000,
			},
		};

		const serializedReq = JSON.stringify(request);
		const restoredReq = JSON.parse(serializedReq);
		expect(restoredReq.request.command).toBe("turn/start");

		const serializedRes = JSON.stringify(response);
		const restoredRes = JSON.parse(serializedRes);
		expect(restoredRes.ok).toBe(true);
		expect(restoredRes.result.status).toBe("admitted");
	});
});
