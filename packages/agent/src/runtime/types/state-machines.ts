export type ThreadDurableState = "active" | "archived" | "deleted";

export type ThreadResidencyState = "not_loaded" | "starting" | "idle" | "active" | "stopping" | "failed";

export type TurnPhase = "admitted" | "in_progress" | "completed" | "interrupted" | "failed";

export interface TurnActiveFlags {
	readonly waitingOnApproval: boolean;
	readonly waitingOnUserInput: boolean;
	readonly cancellationRequested: boolean;
	readonly runningTasksCount: number;
}

export type StepPhase = "started" | "completed" | "failed" | "interrupted";

export type ModelAttemptPhase =
	| "prepared"
	| "dispatch_intent"
	| "response_started"
	| "completed"
	| "failed"
	| "outcome_unknown";

export type ToolAttemptPhase =
	| "attempt_prepared"
	| "execution_dispatch_intent"
	| "execution_started"
	| "result"
	| "failed"
	| "denied"
	| "outcome_unknown";

export type ProcessPhase =
	| "reserved"
	| "starting"
	| "running"
	| "exited"
	| "failed"
	| "killed"
	| "timed_out"
	| "unknown";

export interface ProcessOutcome {
	readonly exitCode?: number;
	readonly signal?: string;
	readonly timedOut: boolean;
	readonly aborted: boolean;
	readonly sandboxDenied: boolean;
	readonly outputTruncated: boolean;
	readonly terminationFailed: boolean;
}
