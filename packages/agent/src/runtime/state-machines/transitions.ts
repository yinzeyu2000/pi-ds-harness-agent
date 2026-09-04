import { InvalidStateTransitionError } from "../types/errors.ts";
import type {
	ModelAttemptPhase,
	ProcessPhase,
	StepPhase,
	ThreadDurableState,
	ThreadResidencyState,
	ToolAttemptPhase,
	TurnPhase,
} from "../types/state-machines.ts";

export const THREAD_DURABLE_TRANSITIONS: Readonly<Record<ThreadDurableState, readonly ThreadDurableState[]>> = {
	active: ["archived", "deleted"],
	archived: ["active", "deleted"],
	deleted: [],
};

export const THREAD_RESIDENCY_TRANSITIONS: Readonly<Record<ThreadResidencyState, readonly ThreadResidencyState[]>> = {
	not_loaded: ["starting"],
	starting: ["idle", "failed"],
	idle: ["active", "stopping"],
	active: ["idle", "stopping"],
	stopping: ["not_loaded"],
	failed: ["not_loaded"],
};

export const TURN_PHASE_TRANSITIONS: Readonly<Record<TurnPhase, readonly TurnPhase[]>> = {
	admitted: ["in_progress", "failed", "interrupted"],
	in_progress: ["completed", "interrupted", "failed"],
	completed: [],
	interrupted: [],
	failed: [],
};

export const STEP_PHASE_TRANSITIONS: Readonly<Record<StepPhase, readonly StepPhase[]>> = {
	started: ["completed", "failed", "interrupted"],
	completed: [],
	failed: [],
	interrupted: [],
};

export const MODEL_ATTEMPT_TRANSITIONS: Readonly<Record<ModelAttemptPhase, readonly ModelAttemptPhase[]>> = {
	prepared: ["dispatch_intent", "failed"],
	dispatch_intent: ["response_started", "failed", "outcome_unknown"],
	response_started: ["completed", "failed", "outcome_unknown"],
	completed: [],
	failed: [],
	outcome_unknown: [],
};

export const TOOL_ATTEMPT_TRANSITIONS: Readonly<Record<ToolAttemptPhase, readonly ToolAttemptPhase[]>> = {
	attempt_prepared: ["execution_dispatch_intent", "denied", "failed"],
	execution_dispatch_intent: ["execution_started", "denied", "failed", "outcome_unknown"],
	execution_started: ["result", "failed", "outcome_unknown"],
	result: [],
	failed: [],
	denied: [],
	outcome_unknown: [],
};

export const PROCESS_PHASE_TRANSITIONS: Readonly<Record<ProcessPhase, readonly ProcessPhase[]>> = {
	reserved: ["starting", "failed"],
	starting: ["running", "failed", "killed"],
	running: ["exited", "failed", "killed", "timed_out", "unknown"],
	exited: [],
	failed: [],
	killed: [],
	timed_out: [],
	unknown: [],
};

export function canTransition<T extends string>(table: Readonly<Record<T, readonly T[]>>, from: T, to: T): boolean {
	const allowed = table[from];
	return allowed ? allowed.includes(to) : false;
}

export function assertTransition<T extends string>(
	entity: string,
	table: Readonly<Record<T, readonly T[]>>,
	from: T,
	to: T,
): void {
	if (!canTransition(table, from, to)) {
		throw new InvalidStateTransitionError(entity, from, to);
	}
}
