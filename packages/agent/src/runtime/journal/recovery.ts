import { asStepId, type ThreadId, type ThreadSnapshot, type TurnId } from "@earendil-works/pi-protocol";
import type {
	JournalDraft,
	JournalEnvelope,
	ModelAttemptFact,
	ThreadJournalStore,
	ToolAttemptFact,
	TurnFact,
} from "../types/journal.ts";
import { projectThreadSnapshot } from "./projection.ts";

export interface RecoverySummary {
	readonly threadId: ThreadId;
	readonly recoveredTurnId?: TurnId;
	readonly unknownModelAttempts: string[];
	readonly unknownToolAttempts: string[];
	readonly recoveredWatermark: number;
}

export async function recoverThread(journalStore: ThreadJournalStore, threadId: ThreadId): Promise<RecoverySummary> {
	const envelopes: JournalEnvelope[] = [];
	for await (const env of journalStore.load(threadId)) {
		envelopes.push(env);
	}

	let openTurnId: TurnId | undefined;
	let openTurnClientReqId: any;
	const activeModelAttempts = new Set<string>();
	const activeToolAttempts = new Set<string>();

	for (const env of envelopes) {
		if (env.record.recordType === "runtime_fact") {
			const fact = env.record.fact;

			if (fact.factType === "turn") {
				const turnFact = fact as TurnFact;
				if (turnFact.status === "admitted" || turnFact.status === "started") {
					openTurnId = turnFact.turnId;
					openTurnClientReqId = turnFact.clientRequestId;
				} else if (
					turnFact.status === "completed" ||
					turnFact.status === "interrupted" ||
					turnFact.status === "failed"
				) {
					if (openTurnId === turnFact.turnId) {
						openTurnId = undefined;
					}
				}
			} else if (fact.factType === "model_attempt") {
				const modelFact = fact as ModelAttemptFact;
				if (modelFact.status === "dispatch_intent" || modelFact.status === "response_started") {
					activeModelAttempts.add(modelFact.modelAttemptId);
				} else if (
					modelFact.status === "completed" ||
					modelFact.status === "failed" ||
					modelFact.status === "outcome_unknown"
				) {
					activeModelAttempts.delete(modelFact.modelAttemptId);
				}
			} else if (fact.factType === "tool_attempt") {
				const toolFact = fact as ToolAttemptFact;
				if (toolFact.status === "execution_dispatch_intent" || toolFact.status === "execution_started") {
					activeToolAttempts.add(toolFact.toolAttemptId);
				} else if (
					toolFact.status === "result" ||
					toolFact.status === "denied" ||
					toolFact.status === "outcome_unknown"
				) {
					activeToolAttempts.delete(toolFact.toolAttemptId);
				}
			}
		}
	}

	const drafts: JournalDraft[] = [];
	const unknownModelList = Array.from(activeModelAttempts);
	const unknownToolList = Array.from(activeToolAttempts);

	// Settle incomplete in-flight model attempts as outcome_unknown
	for (const attemptId of unknownModelList) {
		drafts.push({
			schemaVersion: 1,
			threadId,
			turnId: openTurnId,
			record: {
				recordType: "runtime_fact",
				fact: {
					factType: "model_attempt",
					modelAttemptId: attemptId,
					turnId: openTurnId ?? ("turn_recovered" as any),
					stepId: asStepId("step_recovered"),
					status: "outcome_unknown",
					model: "unknown",
					provider: "unknown",
				} as ModelAttemptFact,
			},
		});
	}

	// Settle incomplete in-flight tool attempts as outcome_unknown (never auto-retry non-idempotent actions)
	for (const toolAttemptId of unknownToolList) {
		drafts.push({
			schemaVersion: 1,
			threadId,
			turnId: openTurnId,
			record: {
				recordType: "runtime_fact",
				fact: {
					factType: "tool_attempt",
					toolAttemptId: toolAttemptId as any,
					toolCallId: `call_${toolAttemptId}` as any,
					turnId: openTurnId ?? ("turn_recovered" as any),
					toolName: "unknown",
					status: "outcome_unknown",
				} as ToolAttemptFact,
			},
		});
	}

	// If a turn was in-flight during the crash, mark it interrupted
	if (openTurnId) {
		drafts.push({
			schemaVersion: 1,
			threadId,
			turnId: openTurnId,
			record: {
				recordType: "runtime_fact",
				fact: {
					factType: "turn",
					turnId: openTurnId,
					status: "interrupted",
					terminal: true,
					clientRequestId: openTurnClientReqId,
					error: {
						code: "CRASH_RECOVERY",
						message: "Process terminated unexpectedly; in-flight turn recovered as interrupted",
					},
				} as TurnFact,
			},
		});
	}

	let watermark = envelopes.length > 0 ? envelopes[envelopes.length - 1]!.seq : 0;

	if (drafts.length > 0) {
		const writer = await journalStore.open(threadId);
		try {
			await writer.append(drafts);
			const receipt = await writer.flush();
			watermark = receipt.durableSeq;
		} finally {
			await writer.shutdown();
		}
	}

	return {
		threadId,
		recoveredTurnId: openTurnId,
		unknownModelAttempts: unknownModelList,
		unknownToolAttempts: unknownToolList,
		recoveredWatermark: watermark,
	};
}

export function assertProjectionParity(online: ThreadSnapshot, replay: ThreadSnapshot): void {
	if (online.threadId !== replay.threadId) {
		throw new Error(`Projection threadId mismatch: online=${online.threadId}, replay=${replay.threadId}`);
	}
	if (online.durableStatus !== replay.durableStatus) {
		throw new Error(
			`Projection durableStatus mismatch: online=${online.durableStatus}, replay=${replay.durableStatus}`,
		);
	}
	if (online.durableWatermarkSeq !== replay.durableWatermarkSeq) {
		throw new Error(
			`Projection durableWatermarkSeq mismatch: online=${online.durableWatermarkSeq}, replay=${replay.durableWatermarkSeq}`,
		);
	}
	if (online.activeTurn?.turnId !== replay.activeTurn?.turnId) {
		throw new Error(
			`Projection activeTurn.turnId mismatch: online=${online.activeTurn?.turnId}, replay=${replay.activeTurn?.turnId}`,
		);
	}
	if (online.activeTurn?.phase !== replay.activeTurn?.phase) {
		throw new Error(
			`Projection activeTurn.phase mismatch: online=${online.activeTurn?.phase}, replay=${replay.activeTurn?.phase}`,
		);
	}
}

export async function replayThreadSnapshot(store: ThreadJournalStore, threadId: ThreadId): Promise<ThreadSnapshot> {
	const envelopes: JournalEnvelope[] = [];
	for await (const env of store.load(threadId)) {
		envelopes.push(env);
	}
	return projectThreadSnapshot(threadId, envelopes);
}
