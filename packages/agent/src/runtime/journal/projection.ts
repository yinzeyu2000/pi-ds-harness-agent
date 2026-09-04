import type { ThreadId, ThreadSnapshot, TurnSnapshot } from "@earendil-works/pi-protocol";
import type { JournalEnvelope, TurnFact } from "../types/journal.ts";

export interface ProjectedThreadState {
	readonly threadId: ThreadId;
	readonly durableStatus: "active" | "archived" | "deleted";
	readonly itemsCount: number;
	readonly latestTurn?: TurnSnapshot;
	readonly durableWatermarkSeq: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export function projectThreadSnapshot(threadId: ThreadId, envelopes: readonly JournalEnvelope[]): ThreadSnapshot {
	const durableStatus: "active" | "archived" | "deleted" = "active";
	let activeTurn: TurnSnapshot | undefined;
	let createdAt = 0;
	let updatedAt = 0;
	let watermark = 0;

	for (const env of envelopes) {
		watermark = Math.max(watermark, env.seq);
		if (createdAt === 0) createdAt = env.timestamp;
		updatedAt = env.timestamp;

		if (env.record.recordType === "runtime_fact") {
			const fact = env.record.fact;
			if (fact.factType === "turn") {
				const turnFact = fact as TurnFact;
				if (turnFact.status === "admitted" || turnFact.status === "started") {
					activeTurn = {
						turnId: turnFact.turnId,
						threadId,
						phase: turnFact.status === "admitted" ? "admitted" : "in_progress",
						admittedAt: env.timestamp,
						startedAt: turnFact.status === "started" ? env.timestamp : undefined,
						activeFlags: {
							waitingOnApproval: false,
							waitingOnUserInput: false,
							cancellationRequested: false,
							runningTasksCount: 0,
						},
						pendingApprovals: [],
					};
				} else if (
					turnFact.status === "completed" ||
					turnFact.status === "interrupted" ||
					turnFact.status === "failed"
				) {
					if (activeTurn && activeTurn.turnId === turnFact.turnId) {
						activeTurn = {
							...activeTurn,
							phase: turnFact.status,
							completedAt: env.timestamp,
							error: turnFact.error,
						};
					}
				}
			}
		}
	}

	return {
		threadId,
		durableStatus,
		residencyStatus:
			activeTurn && (activeTurn.phase === "admitted" || activeTurn.phase === "in_progress") ? "active" : "idle",
		activeTurn:
			activeTurn && (activeTurn.phase === "admitted" || activeTurn.phase === "in_progress") ? activeTurn : undefined,
		createdAt: createdAt || Date.now(),
		updatedAt: updatedAt || Date.now(),
		durableWatermarkSeq: watermark,
	};
}
