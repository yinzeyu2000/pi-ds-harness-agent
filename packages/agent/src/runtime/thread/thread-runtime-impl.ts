import {
	asControllerEpoch,
	asEventId,
	asTurnId,
	type ClientRequestId,
	type ControllerEpoch,
	type ControllerLease,
	type RuntimeGeneration,
	type ThreadId,
	type TurnId,
	type WireEventEnvelope,
} from "@earendil-works/pi-protocol";
import { projectThreadSnapshot } from "../journal/projection.ts";
import { ThreadStateMachine, TurnStateMachine } from "../state-machines/models.ts";
import type { AgentDriver } from "../types/agent-driver.ts";
import { ActiveTurnConflictError, ControllerFencingError } from "../types/errors.ts";
import type { JournalDraft, JournalWriter, TurnFact } from "../types/journal.ts";
import type { AdmittedTurn, LoadedThreadMailbox, ThreadRuntime } from "../types/thread-runtime.ts";
import { LoadedThreadMailboxImpl } from "./mailbox.ts";

export type WireEventListener = (event: WireEventEnvelope) => void;

export class ThreadRuntimeImpl implements ThreadRuntime {
	readonly threadId: ThreadId;
	readonly generation: RuntimeGeneration;
	readonly mailbox: LoadedThreadMailbox;
	readonly journalWriter: JournalWriter;
	private readonly driver: AgentDriver;
	private readonly stateMachine: ThreadStateMachine;
	private _activeController?: ControllerLease;
	private _activeTurn?: AdmittedTurn;
	private _activeAbortController?: AbortController;
	private currentEpochCounter = 0;
	private listeners = new Set<WireEventListener>();
	private terminalCommitted = false;

	constructor(threadId: ThreadId, generation: RuntimeGeneration, journalWriter: JournalWriter, driver: AgentDriver) {
		this.threadId = threadId;
		this.generation = generation;
		this.journalWriter = journalWriter;
		this.driver = driver;
		this.stateMachine = new ThreadStateMachine(threadId, "active", "active");
		this.mailbox = new LoadedThreadMailboxImpl(() => this._activeController);
	}

	get activeController(): ControllerLease | undefined {
		return this._activeController;
	}

	get activeTurn(): AdmittedTurn | undefined {
		return this._activeTurn;
	}

	subscribe(listener: WireEventListener): { dispose: () => void } {
		this.listeners.add(listener);
		return {
			dispose: () => {
				this.listeners.delete(listener);
			},
		};
	}

	broadcastWireEvent(event: WireEventEnvelope): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// Observer errors should not disrupt runtime
			}
		}
	}

	async acquireController(controllerId: string, ttlMs = 60000): Promise<ControllerLease> {
		this.currentEpochCounter++;
		const epoch = asControllerEpoch(this.currentEpochCounter);
		const lease: ControllerLease = {
			threadId: this.threadId,
			controllerId,
			epoch,
			acquiredAt: Date.now(),
			expiresAt: Date.now() + ttlMs,
		};
		this._activeController = lease;
		return lease;
	}

	async releaseController(controllerId: string, epoch: ControllerEpoch): Promise<boolean> {
		if (
			!this._activeController ||
			this._activeController.controllerId !== controllerId ||
			this._activeController.epoch !== epoch
		) {
			return false;
		}
		this._activeController = undefined;
		return true;
	}

	async startTurn(
		input: unknown,
		clientRequestId: ClientRequestId,
		epoch: ControllerEpoch,
		_principalId: string,
	): Promise<AdmittedTurn> {
		// Controller lease fencing check
		if (this._activeController && this._activeController.epoch !== epoch) {
			throw new ControllerFencingError(
				`Epoch ${epoch} does not match active controller lease epoch ${this._activeController.epoch}`,
			);
		}

		// Single ActiveTurn invariant check
		if (this._activeTurn !== undefined) {
			throw new ActiveTurnConflictError(
				`Cannot start turn on thread ${this.threadId}: another turn (${this._activeTurn.turnId}) is already active`,
				{ activeTurnId: this._activeTurn.turnId },
			);
		}

		const turnId = asTurnId(`turn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
		const turnStateMachine = new TurnStateMachine(turnId);
		const now = Date.now();

		const admittedTurn: AdmittedTurn = {
			turnId,
			threadId: this.threadId,
			clientRequestId,
			controllerEpoch: epoch,
			phase: "admitted",
			activeFlags: turnStateMachine.activeFlags,
			admittedAt: now,
		};

		this._activeTurn = admittedTurn;
		this.terminalCommitted = false;
		const abortController = new AbortController();
		this._activeAbortController = abortController;

		// Persist turn.admitted fact
		const turnFact: TurnFact = {
			factType: "turn",
			turnId,
			status: "admitted",
			clientRequestId,
			controllerEpoch: epoch,
		};
		const draft: JournalDraft = {
			schemaVersion: 1,
			threadId: this.threadId,
			turnId,
			record: { recordType: "runtime_fact", fact: turnFact },
		};

		await this.journalWriter.append([draft]);
		await this.journalWriter.persist();

		// Broadcast admitted wire event
		this.broadcastWireEvent({
			eventId: asEventId(`evt_turn_adm_${turnId}`),
			threadId: this.threadId,
			seq: 0,
			type: "turn.admitted",
			payload: { turnId, admittedAt: now },
			timestamp: now,
		});

		// Trigger asynchronous agent driver execution
		void this.executeTurnLoop(turnId, input, abortController.signal, turnStateMachine);

		return admittedTurn;
	}

	private async executeTurnLoop(
		turnId: TurnId,
		input: unknown,
		signal: AbortSignal,
		turnStateMachine: TurnStateMachine,
	): Promise<void> {
		const now = Date.now();
		turnStateMachine.transitionPhase("in_progress");

		this.broadcastWireEvent({
			eventId: asEventId(`evt_turn_start_${turnId}`),
			threadId: this.threadId,
			seq: 0,
			type: "turn.started",
			payload: { turnId, startedAt: now },
			timestamp: now,
		});

		try {
			const result = await this.driver.run({
				threadId: this.threadId,
				turnId,
				input,
				signal,
			});

			await this.settleTerminal(turnId, result.outcome, result.message, turnStateMachine);
		} catch (err) {
			await this.settleTerminal(
				turnId,
				signal.aborted ? "interrupted" : "failed",
				err instanceof Error ? err.message : String(err),
				turnStateMachine,
			);
		}
	}

	private async settleTerminal(
		turnId: TurnId,
		outcome: "completed" | "interrupted" | "failed",
		message?: string,
		turnStateMachine?: TurnStateMachine,
	): Promise<void> {
		// Exactly-once CAS guard
		if (this.terminalCommitted) return;
		this.terminalCommitted = true;

		if (turnStateMachine && turnStateMachine.phase === "in_progress") {
			try {
				turnStateMachine.transitionPhase(outcome);
			} catch {
				// State machine terminal already reached
			}
		}

		const now = Date.now();
		const turnFact: TurnFact = {
			factType: "turn",
			turnId,
			status: outcome,
			terminal: true,
			error: message ? { code: outcome.toUpperCase(), message } : undefined,
		};

		const draft: JournalDraft = {
			schemaVersion: 1,
			threadId: this.threadId,
			turnId,
			record: { recordType: "runtime_fact", fact: turnFact },
		};

		await this.journalWriter.append([draft]);
		await this.journalWriter.flush();

		const wireEventType =
			outcome === "completed" ? "turn.completed" : outcome === "interrupted" ? "turn.interrupted" : "turn.failed";

		this.broadcastWireEvent({
			eventId: asEventId(`evt_turn_term_${turnId}`),
			threadId: this.threadId,
			seq: 0,
			type: wireEventType as any,
			payload: { turnId, outcome, message },
			timestamp: now,
		});

		this._activeTurn = undefined;
		this._activeAbortController = undefined;
	}

	async interruptTurn(turnId: TurnId, epoch: ControllerEpoch, reason?: string): Promise<void> {
		if (!this._activeTurn || this._activeTurn.turnId !== turnId) {
			return;
		}

		if (this._activeController && this._activeController.epoch !== epoch) {
			throw new ControllerFencingError(
				`Epoch ${epoch} does not match active controller lease epoch ${this._activeController.epoch}`,
			);
		}

		if (this._activeAbortController) {
			this._activeAbortController.abort();
		}

		await this.settleTerminal(turnId, "interrupted", reason ?? "Turn interrupted");
	}

	async quiesce(): Promise<void> {
		await this.mailbox.drain();
		await this.journalWriter.persist();
	}

	async shutdown(): Promise<void> {
		if (this._activeAbortController) {
			this._activeAbortController.abort();
		}
		if (this._activeTurn) {
			await this.settleTerminal(this._activeTurn.turnId, "interrupted", "Shutdown");
		}
		await this.mailbox.drain();
		await this.journalWriter.shutdown();
		this.stateMachine.transitionResidency("stopping");
		this.stateMachine.transitionResidency("not_loaded");
	}

	async getSnapshot() {
		// Read envelopes from journal and project
		const envelopes: any[] = [];
		for await (const env of (this.journalWriter as any).committedEnvelopes ?? []) {
			envelopes.push(env);
		}
		return projectThreadSnapshot(this.threadId, envelopes);
	}
}
