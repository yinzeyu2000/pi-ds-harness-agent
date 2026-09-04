import type {
	ModelAttemptPhase,
	ProcessOutcome,
	ProcessPhase,
	StepPhase,
	ThreadDurableState,
	ThreadResidencyState,
	ToolAttemptPhase,
	TurnActiveFlags,
	TurnPhase,
} from "../types/state-machines.ts";
import {
	assertTransition,
	MODEL_ATTEMPT_TRANSITIONS,
	PROCESS_PHASE_TRANSITIONS,
	STEP_PHASE_TRANSITIONS,
	THREAD_DURABLE_TRANSITIONS,
	THREAD_RESIDENCY_TRANSITIONS,
	TOOL_ATTEMPT_TRANSITIONS,
	TURN_PHASE_TRANSITIONS,
} from "./transitions.ts";

export class ThreadStateMachine {
	readonly threadId: string;
	private _durableState: ThreadDurableState;
	private _residencyState: ThreadResidencyState;

	constructor(
		threadId: string,
		initialDurable: ThreadDurableState = "active",
		initialResidency: ThreadResidencyState = "not_loaded",
	) {
		this.threadId = threadId;
		this._durableState = initialDurable;
		this._residencyState = initialResidency;
	}

	get durableState(): ThreadDurableState {
		return this._durableState;
	}

	get residencyState(): ThreadResidencyState {
		return this._residencyState;
	}

	transitionDurable(to: ThreadDurableState): void {
		assertTransition(`Thread(${this.threadId}) durable`, THREAD_DURABLE_TRANSITIONS, this._durableState, to);
		this._durableState = to;
	}

	transitionResidency(to: ThreadResidencyState): void {
		assertTransition(`Thread(${this.threadId}) residency`, THREAD_RESIDENCY_TRANSITIONS, this._residencyState, to);
		this._residencyState = to;
	}
}

export class TurnStateMachine {
	readonly turnId: string;
	private _phase: TurnPhase;
	private _activeFlags: TurnActiveFlags;

	constructor(turnId: string) {
		this.turnId = turnId;
		this._phase = "admitted";
		this._activeFlags = {
			waitingOnApproval: false,
			waitingOnUserInput: false,
			cancellationRequested: false,
			runningTasksCount: 0,
		};
	}

	get phase(): TurnPhase {
		return this._phase;
	}

	get activeFlags(): TurnActiveFlags {
		return { ...this._activeFlags };
	}

	transitionPhase(to: TurnPhase): void {
		assertTransition(`Turn(${this.turnId})`, TURN_PHASE_TRANSITIONS, this._phase, to);
		this._phase = to;
	}

	setWaitingOnApproval(waiting: boolean): void {
		this._activeFlags = { ...this._activeFlags, waitingOnApproval: waiting };
	}

	setWaitingOnUserInput(waiting: boolean): void {
		this._activeFlags = { ...this._activeFlags, waitingOnUserInput: waiting };
	}

	requestCancellation(): void {
		this._activeFlags = { ...this._activeFlags, cancellationRequested: true };
	}

	updateRunningTasks(count: number): void {
		if (count < 0) throw new RangeError("Running tasks count cannot be negative");
		this._activeFlags = { ...this._activeFlags, runningTasksCount: count };
	}
}

export class StepStateMachine {
	readonly stepId: string;
	private _phase: StepPhase;

	constructor(stepId: string) {
		this.stepId = stepId;
		this._phase = "started";
	}

	get phase(): StepPhase {
		return this._phase;
	}

	transitionPhase(to: StepPhase): void {
		assertTransition(`Step(${this.stepId})`, STEP_PHASE_TRANSITIONS, this._phase, to);
		this._phase = to;
	}
}

export class ModelAttemptStateMachine {
	readonly attemptId: string;
	private _phase: ModelAttemptPhase;

	constructor(attemptId: string) {
		this.attemptId = attemptId;
		this._phase = "prepared";
	}

	get phase(): ModelAttemptPhase {
		return this._phase;
	}

	transitionPhase(to: ModelAttemptPhase): void {
		assertTransition(`ModelAttempt(${this.attemptId})`, MODEL_ATTEMPT_TRANSITIONS, this._phase, to);
		this._phase = to;
	}
}

export class ToolAttemptStateMachine {
	readonly attemptId: string;
	private _phase: ToolAttemptPhase;

	constructor(attemptId: string) {
		this.attemptId = attemptId;
		this._phase = "attempt_prepared";
	}

	get phase(): ToolAttemptPhase {
		return this._phase;
	}

	transitionPhase(to: ToolAttemptPhase): void {
		assertTransition(`ToolAttempt(${this.attemptId})`, TOOL_ATTEMPT_TRANSITIONS, this._phase, to);
		this._phase = to;
	}
}

export class ProcessStateMachine {
	readonly processId: string;
	private _phase: ProcessPhase;
	private _outcome?: ProcessOutcome;

	constructor(processId: string) {
		this.processId = processId;
		this._phase = "reserved";
	}

	get phase(): ProcessPhase {
		return this._phase;
	}

	get outcome(): ProcessOutcome | undefined {
		return this._outcome;
	}

	transitionPhase(to: ProcessPhase, outcome?: ProcessOutcome): void {
		assertTransition(`Process(${this.processId})`, PROCESS_PHASE_TRANSITIONS, this._phase, to);
		this._phase = to;
		if (outcome) {
			this._outcome = outcome;
		}
	}
}
