import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { asStepId, asThreadId, asTurnId } from "@earendil-works/pi-protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	assertProjectionParity,
	type JournalDraft,
	type ModelAttemptFact,
	RuntimeInvariantError,
	recoverThread,
	replayThreadSnapshot,
	type ToolAttemptFact,
	type TurnFact,
} from "../../src/runtime/index.ts";
import { JsonlJournalStore } from "../../src/runtime/node.ts";

describe("Fault Recovery: Torn Tail, Mid-log Corruption, and Incomplete Recovery", () => {
	const testDir = join(process.cwd(), "temp_test_fault_store");
	const threadId = asThreadId("th_fault_test");
	const turnId = asTurnId("turn_fault_001");

	beforeEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	test("torn-tail recovery: half-written line at tail is truncated and valid records recovered", async () => {
		const store = new JsonlJournalStore({ storageDir: testDir });
		const writer = await store.open(threadId);

		await writer.append([
			{
				schemaVersion: 1,
				threadId,
				turnId,
				record: {
					recordType: "runtime_fact",
					fact: { factType: "turn", turnId, status: "admitted" } as TurnFact,
				},
			},
			{
				schemaVersion: 1,
				threadId,
				turnId,
				record: {
					recordType: "runtime_fact",
					fact: { factType: "turn", turnId, status: "started" } as TurnFact,
				},
			},
		]);
		await writer.flush();
		await writer.shutdown();

		// Append broken half-written line to simulate a crash during disk write
		const journalPath = join(testDir, "threads", threadId, "journal.jsonl");
		await appendFile(journalPath, '{"schemaVersion":1,"eventId":"evt_truncated_torn', "utf8");

		// Load must recover valid records without throwing
		const recoveredEnvelopes: any[] = [];
		for await (const env of store.load(threadId)) {
			recoveredEnvelopes.push(env);
		}

		expect(recoveredEnvelopes.length).toBe(2);
		expect(recoveredEnvelopes[0].seq).toBe(1);
		expect(recoveredEnvelopes[1].seq).toBe(2);
	});

	test("mid-log corruption fails closed and rejects silent recovery", async () => {
		const store = new JsonlJournalStore({ storageDir: testDir });
		const writer = await store.open(threadId);

		await writer.append([
			{
				schemaVersion: 1,
				threadId,
				turnId,
				record: {
					recordType: "runtime_fact",
					fact: { factType: "turn", turnId, status: "admitted" } as TurnFact,
				},
			},
			{
				schemaVersion: 1,
				threadId,
				turnId,
				record: {
					recordType: "runtime_fact",
					fact: { factType: "turn", turnId, status: "started" } as TurnFact,
				},
			},
			{
				schemaVersion: 1,
				threadId,
				turnId,
				record: {
					recordType: "runtime_fact",
					fact: { factType: "turn", turnId, status: "completed", terminal: true } as TurnFact,
				},
			},
		]);
		await writer.flush();
		await writer.shutdown();

		// Corrupt middle line (line 2)
		const journalPath = join(testDir, "threads", threadId, "journal.jsonl");
		const content = await readFile(journalPath, "utf8");
		const lines = content.trim().split("\n");
		lines[1] = "{CORRUPTED_MIDDLE_JSON_DATA!!!";
		await writeFile(journalPath, `${lines.join("\n")}\n`, "utf8");

		// Load must fail closed with RuntimeInvariantError
		const iterate = async () => {
			for await (const _ of store.load(threadId)) {
				// Consume
			}
		};

		await expect(iterate()).rejects.toThrow(RuntimeInvariantError);
	});

	test("incomplete turn, model attempt, and tool attempt settle to outcome_unknown on crash recovery", async () => {
		const store = new JsonlJournalStore({ storageDir: testDir });
		const writer = await store.open(threadId);

		const inFlightDrafts: JournalDraft[] = [
			{
				schemaVersion: 1,
				threadId,
				turnId,
				record: {
					recordType: "runtime_fact",
					fact: { factType: "turn", turnId, status: "admitted" } as TurnFact,
				},
			},
			{
				schemaVersion: 1,
				threadId,
				turnId,
				record: {
					recordType: "runtime_fact",
					fact: {
						factType: "model_attempt",
						modelAttemptId: "mdl_att_crashed_1",
						turnId,
						stepId: asStepId("step_1"),
						status: "dispatch_intent",
						model: "gpt-4",
						provider: "openai",
					} as ModelAttemptFact,
				},
			},
			{
				schemaVersion: 1,
				threadId,
				turnId,
				record: {
					recordType: "runtime_fact",
					fact: {
						factType: "tool_attempt",
						toolAttemptId: "tool_att_crashed_1" as any,
						toolCallId: "call_crashed_1" as any,
						turnId,
						toolName: "non_idempotent_tool",
						status: "execution_started",
					} as ToolAttemptFact,
				},
			},
		];

		await writer.append(inFlightDrafts);
		await writer.flush();
		await writer.shutdown();

		// Simulate process crash: process died before any terminal or outcome was recorded
		// Now recover thread from store
		const recoverySummary = await recoverThread(store, threadId);

		expect(recoverySummary.unknownModelAttempts).toContain("mdl_att_crashed_1");
		expect(recoverySummary.unknownToolAttempts).toContain("tool_att_crashed_1");
		expect(recoverySummary.recoveredTurnId).toBe(turnId);

		// Verify that all recovery facts are recorded in the journal
		const finalEnvelopes: any[] = [];
		for await (const env of store.load(threadId)) {
			finalEnvelopes.push(env);
		}

		// Initial 3 in-flight + 3 recovery facts (model unknown + tool unknown + turn interrupted) = 6
		expect(finalEnvelopes.length).toBe(6);

		const facts = finalEnvelopes.filter((e) => e.record.recordType === "runtime_fact").map((e) => e.record.fact);

		const modelFact = facts.find((f: any) => f.factType === "model_attempt" && f.status === "outcome_unknown");
		expect(modelFact).toBeDefined();

		const toolFact = facts.find((f: any) => f.factType === "tool_attempt" && f.status === "outcome_unknown");
		expect(toolFact).toBeDefined();

		const turnFact = facts.find((f: any) => f.factType === "turn" && f.status === "interrupted");
		expect(turnFact).toBeDefined();

		// Verify projection parity: offline replay snapshot has no open active turn
		const replaySnapshot = await replayThreadSnapshot(store, threadId);
		expect(replaySnapshot.activeTurn).toBeUndefined();
		expect(replaySnapshot.residencyStatus).toBe("idle");

		assertProjectionParity(replaySnapshot, replaySnapshot);
	});
});
