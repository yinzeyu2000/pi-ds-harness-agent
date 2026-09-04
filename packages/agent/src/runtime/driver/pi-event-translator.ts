import {
	asEventId,
	asItemId,
	asStepId,
	type ThreadId,
	type TurnId,
	type WireEventEnvelope,
} from "@earendil-works/pi-protocol";
import type { AgentEvent } from "../../types.ts";
import type { JournalDraft, StepFact, TurnFact } from "../types/journal.ts";

export interface TranslatedPiEvent {
	readonly wireEvent?: WireEventEnvelope;
	readonly journalDrafts: readonly JournalDraft[];
}

export class PiEventTranslator {
	readonly threadId: ThreadId;
	readonly turnId: TurnId;
	private stepCounter = 0;
	private currentStepId = asStepId("step_0");

	constructor(threadId: ThreadId, turnId: TurnId) {
		this.threadId = threadId;
		this.turnId = turnId;
	}

	translate(event: AgentEvent): TranslatedPiEvent {
		const now = Date.now();

		switch (event.type) {
			case "turn_start": {
				this.stepCounter++;
				this.currentStepId = asStepId(`step_${this.turnId}_${this.stepCounter}`);
				const stepFact: StepFact = {
					factType: "step",
					stepId: this.currentStepId,
					turnId: this.turnId,
					stepIndex: this.stepCounter,
					status: "started",
					model: "pi-model",
					provider: "pi-provider",
				};
				const draft: JournalDraft = {
					schemaVersion: 1,
					threadId: this.threadId,
					turnId: this.turnId,
					stepId: this.currentStepId,
					record: { recordType: "runtime_fact", fact: stepFact },
				};
				const wireEvent: WireEventEnvelope = {
					eventId: asEventId(`evt_step_${this.stepCounter}`),
					threadId: this.threadId,
					seq: this.stepCounter,
					type: "step.started",
					payload: { stepId: this.currentStepId, turnId: this.turnId },
					timestamp: now,
				};
				return { wireEvent, journalDrafts: [draft] };
			}

			case "turn_end": {
				const stepFact: StepFact = {
					factType: "step",
					stepId: this.currentStepId,
					turnId: this.turnId,
					stepIndex: this.stepCounter,
					status: "completed",
					model: "pi-model",
					provider: "pi-provider",
				};
				const draft: JournalDraft = {
					schemaVersion: 1,
					threadId: this.threadId,
					turnId: this.turnId,
					stepId: this.currentStepId,
					record: { recordType: "runtime_fact", fact: stepFact },
				};
				const wireEvent: WireEventEnvelope = {
					eventId: asEventId(`evt_step_end_${this.stepCounter}`),
					threadId: this.threadId,
					seq: this.stepCounter,
					type: "step.completed",
					payload: { stepId: this.currentStepId, turnId: this.turnId },
					timestamp: now,
				};
				return { wireEvent, journalDrafts: [draft] };
			}

			case "message_end": {
				const message = event.message;
				const itemId = asItemId(`item_${now}`);
				const draft: JournalDraft = {
					schemaVersion: 1,
					threadId: this.threadId,
					turnId: this.turnId,
					stepId: this.currentStepId,
					record: {
						recordType: "entry",
						entry: {
							type: "message",
							id: itemId,
							seq: 0,
							parentId: null,
							timestamp: now,
							message,
						},
					},
				};
				const wireEvent: WireEventEnvelope = {
					eventId: asEventId(`evt_item_${now}`),
					threadId: this.threadId,
					seq: 0,
					type: "item.completed",
					payload: { itemId, message },
					timestamp: now,
				};
				return { wireEvent, journalDrafts: [draft] };
			}

			case "agent_end": {
				const turnFact: TurnFact = {
					factType: "turn",
					turnId: this.turnId,
					status: "completed",
					terminal: true,
				};
				const draft: JournalDraft = {
					schemaVersion: 1,
					threadId: this.threadId,
					turnId: this.turnId,
					record: { recordType: "runtime_fact", fact: turnFact },
				};
				const wireEvent: WireEventEnvelope = {
					eventId: asEventId(`evt_turn_end_${now}`),
					threadId: this.threadId,
					seq: 0,
					type: "turn.completed",
					payload: { turnId: this.turnId },
					timestamp: now,
				};
				return { wireEvent, journalDrafts: [draft] };
			}

			default:
				return { journalDrafts: [] };
		}
	}
}
