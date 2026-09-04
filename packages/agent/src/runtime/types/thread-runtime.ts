import type {
	ClientRequestId,
	ControllerEpoch,
	ControllerLease,
	DeduplicationKey,
	RuntimeGeneration,
	ThreadId,
	TurnId,
} from "@earendil-works/pi-protocol";
import type { JournalWriter } from "./journal.ts";
import type { TurnActiveFlags, TurnPhase } from "./state-machines.ts";

export interface MailboxMessage<T = unknown> {
	readonly method: string;
	readonly clientRequestId: ClientRequestId;
	readonly principalId: string;
	readonly controllerEpoch?: ControllerEpoch;
	readonly payload: T;
	readonly dedupeKey: DeduplicationKey;
}

export interface AdmittedTurn {
	readonly turnId: TurnId;
	readonly threadId: ThreadId;
	readonly clientRequestId: ClientRequestId;
	readonly controllerEpoch: ControllerEpoch;
	readonly phase: TurnPhase;
	readonly activeFlags: TurnActiveFlags;
	readonly admittedAt: number;
}

export interface LoadedThreadMailbox {
	submit<TInput, TOutput>(message: MailboxMessage<TInput>): Promise<TOutput>;
	drain(): Promise<void>;
	readonly pendingCount: number;
}

export interface ThreadRuntime {
	readonly threadId: ThreadId;
	readonly generation: RuntimeGeneration;
	readonly mailbox: LoadedThreadMailbox;
	readonly journalWriter: JournalWriter;
	readonly activeController?: ControllerLease;
	readonly activeTurn?: AdmittedTurn;

	acquireController(controllerId: string, ttlMs?: number): Promise<ControllerLease>;
	releaseController(controllerId: string, epoch: ControllerEpoch): Promise<boolean>;
	startTurn(
		input: unknown,
		clientRequestId: ClientRequestId,
		epoch: ControllerEpoch,
		principalId: string,
	): Promise<AdmittedTurn>;
	interruptTurn(turnId: TurnId, epoch: ControllerEpoch, reason?: string): Promise<void>;
	quiesce(): Promise<void>;
	shutdown(): Promise<void>;
}
