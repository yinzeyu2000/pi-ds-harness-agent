export type RuntimeErrorCode =
	| "USER_TOOL_ERROR"
	| "POLICY_DENIED"
	| "APPROVAL_DENIED"
	| "APPROVAL_TIMEOUT"
	| "APPROVAL_DISCONNECTED"
	| "SANDBOX_UNSUPPORTED"
	| "SANDBOX_VIOLATION"
	| "EXECUTION_FAILED"
	| "RUNTIME_INVARIANT_BROKEN"
	| "OUTCOME_UNKNOWN"
	| "CONTROLLER_FENCING_STALE"
	| "COMMAND_DEDUPLICATION_CONFLICT"
	| "INVALID_STATE_TRANSITION"
	| "THREAD_NOT_LOADED"
	| "THREAD_ALREADY_LOADED"
	| "ACTIVE_TURN_CONFLICT";

export abstract class BaseRuntimeError extends Error {
	readonly code: RuntimeErrorCode;
	readonly details?: unknown;

	constructor(code: RuntimeErrorCode, message: string, details?: unknown) {
		super(message);
		this.name = "BaseRuntimeError";
		this.code = code;
		this.details = details;
	}
}

export class UserToolError extends BaseRuntimeError {
	constructor(message: string, details?: unknown) {
		super("USER_TOOL_ERROR", message, details);
		this.name = "UserToolError";
	}
}

export class PolicyDeniedError extends BaseRuntimeError {
	constructor(message: string, details?: unknown) {
		super("POLICY_DENIED", message, details);
		this.name = "PolicyDeniedError";
	}
}

export class ApprovalDeniedError extends BaseRuntimeError {
	constructor(message: string, details?: unknown) {
		super("APPROVAL_DENIED", message, details);
		this.name = "ApprovalDeniedError";
	}
}

export class SandboxUnsupportedError extends BaseRuntimeError {
	constructor(message: string, details?: unknown) {
		super("SANDBOX_UNSUPPORTED", message, details);
		this.name = "SandboxUnsupportedError";
	}
}

export class SandboxViolationError extends BaseRuntimeError {
	constructor(message: string, details?: unknown) {
		super("SANDBOX_VIOLATION", message, details);
		this.name = "SandboxViolationError";
	}
}

export class ExecutionFailedError extends BaseRuntimeError {
	constructor(message: string, details?: unknown) {
		super("EXECUTION_FAILED", message, details);
		this.name = "ExecutionFailedError";
	}
}

export class RuntimeInvariantError extends BaseRuntimeError {
	constructor(message: string, details?: unknown) {
		super("RUNTIME_INVARIANT_BROKEN", message, details);
		this.name = "RuntimeInvariantError";
	}
}

export class OutcomeUnknownError extends BaseRuntimeError {
	constructor(message: string, details?: unknown) {
		super("OUTCOME_UNKNOWN", message, details);
		this.name = "OutcomeUnknownError";
	}
}

export class ControllerFencingError extends BaseRuntimeError {
	constructor(message: string, details?: unknown) {
		super("CONTROLLER_FENCING_STALE", message, details);
		this.name = "ControllerFencingError";
	}
}

export class CommandDeduplicationConflictError extends BaseRuntimeError {
	constructor(message: string, details?: unknown) {
		super("COMMAND_DEDUPLICATION_CONFLICT", message, details);
		this.name = "CommandDeduplicationConflictError";
	}
}

export class InvalidStateTransitionError extends BaseRuntimeError {
	readonly entity: string;
	readonly fromState: string;
	readonly toState: string;

	constructor(entity: string, fromState: string, toState: string, reason?: string) {
		const msg = `Invalid state transition for ${entity}: ${fromState} -> ${toState}${reason ? ` (${reason})` : ""}`;
		super("INVALID_STATE_TRANSITION", msg, { entity, fromState, toState, reason });
		this.name = "InvalidStateTransitionError";
		this.entity = entity;
		this.fromState = fromState;
		this.toState = toState;
	}
}

export class ActiveTurnConflictError extends BaseRuntimeError {
	constructor(message: string, details?: unknown) {
		super("ACTIVE_TURN_CONFLICT", message, details);
		this.name = "ActiveTurnConflictError";
	}
}
