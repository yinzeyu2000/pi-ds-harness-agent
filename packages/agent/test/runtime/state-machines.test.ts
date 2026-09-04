import { describe, expect, test } from "vitest";
import {
	InvalidStateTransitionError,
	ModelAttemptStateMachine,
	ProcessStateMachine,
	StepStateMachine,
	ThreadStateMachine,
	ToolAttemptStateMachine,
	TurnStateMachine,
} from "../../src/runtime/index.ts";

describe("State Machine Model Tests", () => {
	describe("ThreadStateMachine", () => {
		test("valid durable transitions: active -> archived -> active -> deleted", () => {
			const sm = new ThreadStateMachine("th_1");
			expect(sm.durableState).toBe("active");

			sm.transitionDurable("archived");
			expect(sm.durableState).toBe("archived");

			sm.transitionDurable("active");
			expect(sm.durableState).toBe("active");

			sm.transitionDurable("deleted");
			expect(sm.durableState).toBe("deleted");

			// deleted is terminal, cannot transition further
			expect(() => sm.transitionDurable("active")).toThrow(InvalidStateTransitionError);
			expect(() => sm.transitionDurable("archived")).toThrow(InvalidStateTransitionError);
		});

		test("valid residency transitions: not_loaded -> starting -> idle -> active -> idle -> stopping -> not_loaded", () => {
			const sm = new ThreadStateMachine("th_2");
			expect(sm.residencyState).toBe("not_loaded");

			sm.transitionResidency("starting");
			expect(sm.residencyState).toBe("starting");

			sm.transitionResidency("idle");
			expect(sm.residencyState).toBe("idle");

			sm.transitionResidency("active");
			expect(sm.residencyState).toBe("active");

			sm.transitionResidency("idle");
			expect(sm.residencyState).toBe("idle");

			sm.transitionResidency("stopping");
			expect(sm.residencyState).toBe("stopping");

			sm.transitionResidency("not_loaded");
			expect(sm.residencyState).toBe("not_loaded");
		});

		test("illegal residency transition throws InvalidStateTransitionError", () => {
			const sm = new ThreadStateMachine("th_3");
			// cannot jump directly from not_loaded to active
			expect(() => sm.transitionResidency("active")).toThrow(InvalidStateTransitionError);
			// cannot jump from not_loaded to stopping
			expect(() => sm.transitionResidency("stopping")).toThrow(InvalidStateTransitionError);
		});
	});

	describe("TurnStateMachine", () => {
		test("valid normal flow: admitted -> in_progress -> completed", () => {
			const turn = new TurnStateMachine("turn_1");
			expect(turn.phase).toBe("admitted");
			expect(turn.activeFlags.waitingOnApproval).toBe(false);

			turn.transitionPhase("in_progress");
			expect(turn.phase).toBe("in_progress");

			turn.setWaitingOnApproval(true);
			expect(turn.activeFlags.waitingOnApproval).toBe(true);

			turn.setWaitingOnApproval(false);
			expect(turn.activeFlags.waitingOnApproval).toBe(false);

			turn.transitionPhase("completed");
			expect(turn.phase).toBe("completed");

			// terminal cannot transition again
			expect(() => turn.transitionPhase("in_progress")).toThrow(InvalidStateTransitionError);
			expect(() => turn.transitionPhase("interrupted")).toThrow(InvalidStateTransitionError);
		});

		test("valid cancellation flow: admitted -> in_progress -> interrupted", () => {
			const turn = new TurnStateMachine("turn_2");
			turn.transitionPhase("in_progress");
			turn.requestCancellation();
			expect(turn.activeFlags.cancellationRequested).toBe(true);

			turn.transitionPhase("interrupted");
			expect(turn.phase).toBe("interrupted");
		});

		test("illegal transition throws InvalidStateTransitionError", () => {
			const turn = new TurnStateMachine("turn_3");
			// cannot jump from admitted directly to completed without in_progress
			expect(() => turn.transitionPhase("completed")).toThrow(InvalidStateTransitionError);
		});
	});

	describe("StepStateMachine", () => {
		test("valid flow: started -> completed", () => {
			const step = new StepStateMachine("step_1");
			expect(step.phase).toBe("started");

			step.transitionPhase("completed");
			expect(step.phase).toBe("completed");
			expect(() => step.transitionPhase("failed")).toThrow(InvalidStateTransitionError);
		});

		test("valid failure flow: started -> failed", () => {
			const step = new StepStateMachine("step_2");
			step.transitionPhase("failed");
			expect(step.phase).toBe("failed");
		});
	});

	describe("ModelAttemptStateMachine", () => {
		test("valid full flow: prepared -> dispatch_intent -> response_started -> completed", () => {
			const ma = new ModelAttemptStateMachine("att_1");
			expect(ma.phase).toBe("prepared");

			ma.transitionPhase("dispatch_intent");
			expect(ma.phase).toBe("dispatch_intent");

			ma.transitionPhase("response_started");
			expect(ma.phase).toBe("response_started");

			ma.transitionPhase("completed");
			expect(ma.phase).toBe("completed");
		});

		test("outcome_unknown from dispatch_intent after crash/timeout", () => {
			const ma = new ModelAttemptStateMachine("att_2");
			ma.transitionPhase("dispatch_intent");
			ma.transitionPhase("outcome_unknown");
			expect(ma.phase).toBe("outcome_unknown");
		});

		test("illegal transition: prepared cannot jump directly to response_started", () => {
			const ma = new ModelAttemptStateMachine("att_3");
			expect(() => ma.transitionPhase("response_started")).toThrow(InvalidStateTransitionError);
		});
	});

	describe("ToolAttemptStateMachine", () => {
		test("valid full flow: attempt_prepared -> execution_dispatch_intent -> execution_started -> result", () => {
			const ta = new ToolAttemptStateMachine("tool_att_1");
			expect(ta.phase).toBe("attempt_prepared");

			ta.transitionPhase("execution_dispatch_intent");
			expect(ta.phase).toBe("execution_dispatch_intent");

			ta.transitionPhase("execution_started");
			expect(ta.phase).toBe("execution_started");

			ta.transitionPhase("result");
			expect(ta.phase).toBe("result");
		});

		test("denial flow: attempt_prepared -> denied without execution", () => {
			const ta = new ToolAttemptStateMachine("tool_att_2");
			ta.transitionPhase("denied");
			expect(ta.phase).toBe("denied");
		});

		test("outcome_unknown flow: execution_started -> outcome_unknown", () => {
			const ta = new ToolAttemptStateMachine("tool_att_3");
			ta.transitionPhase("execution_dispatch_intent");
			ta.transitionPhase("execution_started");
			ta.transitionPhase("outcome_unknown");
			expect(ta.phase).toBe("outcome_unknown");
		});

		test("illegal transition: attempt_prepared cannot jump directly to execution_started", () => {
			const ta = new ToolAttemptStateMachine("tool_att_4");
			expect(() => ta.transitionPhase("execution_started")).toThrow(InvalidStateTransitionError);
		});
	});

	describe("ProcessStateMachine", () => {
		test("valid lifecycle: reserved -> starting -> running -> exited", () => {
			const proc = new ProcessStateMachine("proc_1");
			expect(proc.phase).toBe("reserved");

			proc.transitionPhase("starting");
			expect(proc.phase).toBe("starting");

			proc.transitionPhase("running");
			expect(proc.phase).toBe("running");

			proc.transitionPhase("exited", {
				exitCode: 0,
				timedOut: false,
				aborted: false,
				sandboxDenied: false,
				outputTruncated: false,
				terminationFailed: false,
			});
			expect(proc.phase).toBe("exited");
			expect(proc.outcome?.exitCode).toBe(0);
		});

		test("process timeout with exitCode preservation", () => {
			const proc = new ProcessStateMachine("proc_2");
			proc.transitionPhase("starting");
			proc.transitionPhase("running");
			proc.transitionPhase("timed_out", {
				exitCode: 0,
				timedOut: true,
				aborted: false,
				sandboxDenied: false,
				outputTruncated: false,
				terminationFailed: false,
			});
			expect(proc.phase).toBe("timed_out");
			expect(proc.outcome?.timedOut).toBe(true);
			expect(proc.outcome?.exitCode).toBe(0);
		});

		test("illegal transition: reserved cannot jump to exited", () => {
			const proc = new ProcessStateMachine("proc_3");
			expect(() => proc.transitionPhase("exited")).toThrow(InvalidStateTransitionError);
		});
	});
});
