import { asStepId, asThreadId, asToolAttemptId, asToolCallId, asTurnId } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import {
	ExecutionBrokerImpl,
	MemoryJournalStore,
	type PreparedAction,
	type ToolAttemptCoordinator,
	type ToolAttemptFact,
	type ToolExecutionContext,
} from "../../src/runtime/index.ts";
import { ProcessSupervisorImpl } from "../../src/runtime/node.ts";

describe("ExecutionBrokerImpl and Write-Before-Execute Barrier", () => {
	const threadId = asThreadId("th_broker_test");
	const turnId = asTurnId("turn_broker_test");
	const stepId = asStepId("step_broker_test");
	const toolCallId = asToolCallId("call_b1");
	const toolAttemptId = asToolAttemptId("att_b1");

	const toolContext: ToolExecutionContext = {
		toolAttemptId,
		toolCallId,
		turnId,
		stepId,
		signal: new AbortController().signal,
	};

	test("enforces write-before-execute barrier: onDispatchIntent flushes before process spawn", async () => {
		const journalStore = new MemoryJournalStore();
		const writer = await journalStore.open(threadId);
		const supervisor = new ProcessSupervisorImpl();

		const eventSequence: string[] = [];

		const coordinator: ToolAttemptCoordinator = {
			onAttemptPrepared: async (_id, _action) => {
				eventSequence.push("attempt_prepared");
				await writer.append([
					{
						schemaVersion: 1,
						threadId,
						turnId,
						record: {
							recordType: "runtime_fact",
							fact: {
								factType: "tool_attempt",
								toolAttemptId,
								toolCallId,
								turnId,
								toolName: "bash",
								status: "attempt_prepared",
							} as ToolAttemptFact,
						},
					},
				]);
			},
			onDispatchIntent: async (_id) => {
				eventSequence.push("dispatch_intent_flush");
				await writer.append([
					{
						schemaVersion: 1,
						threadId,
						turnId,
						record: {
							recordType: "runtime_fact",
							fact: {
								factType: "tool_attempt",
								toolAttemptId,
								toolCallId,
								turnId,
								toolName: "bash",
								status: "execution_dispatch_intent",
							} as ToolAttemptFact,
						},
					},
				]);
				// Physical/durable barrier flush
				await writer.flush();
			},
			onExecutionStarted: async (_id) => {
				eventSequence.push("execution_started");
			},
			onAttemptSettled: async (_id, outcome) => {
				eventSequence.push(`attempt_settled_${outcome.status}`);
				await writer.append([
					{
						schemaVersion: 1,
						threadId,
						turnId,
						record: {
							recordType: "runtime_fact",
							fact: {
								factType: "tool_attempt",
								toolAttemptId,
								toolCallId,
								turnId,
								toolName: "bash",
								status: "result",
							} as ToolAttemptFact,
						},
					},
				]);
				await writer.flush();
			},
		};

		const broker = new ExecutionBrokerImpl({
			coordinator,
			supervisor,
		});

		const action = await broker.prepareAction(
			"bash",
			{ command: process.execPath, args: ["-e", "console.log('broker execute ok');"] },
			toolContext,
		);

		const outcome = await broker.executeAction(action, toolContext);

		expect(outcome.status).toBe("completed");
		expect(eventSequence).toEqual([
			"attempt_prepared",
			"dispatch_intent_flush",
			"execution_started",
			"attempt_settled_completed",
		]);

		const output = outcome.output as any;
		expect(output.stdout).toContain("broker execute ok");
		expect(output.exitCode).toBe(0);

		await writer.shutdown();
	});

	test("security policy denial halts pipeline before write-before-execute barrier and skips execution", async () => {
		let executionTriggered = false;

		const coordinator: ToolAttemptCoordinator = {
			onAttemptPrepared: async () => {},
			onDispatchIntent: async () => {
				executionTriggered = true;
			},
			onExecutionStarted: async () => {},
			onAttemptSettled: async () => {},
		};

		const broker = new ExecutionBrokerImpl({
			coordinator,
			policyChecker: (_action: PreparedAction) => {
				// Reject action
				return false;
			},
		});

		const action = await broker.prepareAction("bash", { command: "rm -rf /" }, toolContext);
		const outcome = await broker.executeAction(action, toolContext);

		expect(outcome.status).toBe("denied");
		expect(executionTriggered).toBe(false); // Verified: dispatch intent was NOT triggered!
	});
});
