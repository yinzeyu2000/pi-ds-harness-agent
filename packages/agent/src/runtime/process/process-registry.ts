import type { ProcessId, ThreadId, TurnId } from "@earendil-works/pi-protocol";
import type { ProcessHandle, ProcessOutcome, ProcessSupervisor } from "../types/providers.ts";
import type { BoundedOutputBuffer } from "./output-buffer.ts";

export interface ProcessRecord {
	readonly processId: ProcessId;
	readonly threadId: ThreadId;
	readonly turnId?: TurnId;
	ownership: "foreground" | "background";
	status: "reserved" | "starting" | "running" | "exited" | "failed" | "killed" | "timed_out" | "unknown";
	readonly startedAt: number;
	handle?: ProcessHandle;
	buffer: BoundedOutputBuffer;
	outcome?: ProcessOutcome;
}

export class ProcessRegistry {
	private readonly processes = new Map<string, ProcessRecord>();

	register(record: ProcessRecord): void {
		this.processes.set(record.processId, record);
	}

	get(processId: ProcessId): ProcessRecord | undefined {
		return this.processes.get(processId);
	}

	listByThread(threadId: ThreadId): ProcessRecord[] {
		return Array.from(this.processes.values()).filter((p) => p.threadId === threadId);
	}

	listByTurn(turnId: TurnId): ProcessRecord[] {
		return Array.from(this.processes.values()).filter((p) => p.turnId === turnId);
	}

	promoteToBackground(processId: ProcessId): void {
		const record = this.processes.get(processId);
		if (!record) {
			throw new Error(`Process not found: ${processId}`);
		}
		record.ownership = "background";
	}

	async terminateTurnProcesses(turnId: TurnId, supervisor: ProcessSupervisor): Promise<ProcessOutcome[]> {
		const foreground = Array.from(this.processes.values()).filter(
			(p) => p.turnId === turnId && p.ownership === "foreground" && p.status === "running",
		);

		const outcomes: ProcessOutcome[] = [];
		for (const record of foreground) {
			try {
				const outcome = await supervisor.terminate(record.processId);
				record.outcome = outcome;
				record.status = outcome.timedOut ? "timed_out" : outcome.aborted ? "killed" : "exited";
				outcomes.push(outcome);
			} catch (_err) {
				const failureOutcome: ProcessOutcome = {
					timedOut: false,
					aborted: true,
					sandboxDenied: false,
					outputTruncated: record.buffer.truncated,
					terminationFailed: true,
				};
				record.outcome = failureOutcome;
				record.status = "unknown";
				outcomes.push(failureOutcome);
			}
		}

		return outcomes;
	}

	unregister(processId: ProcessId): void {
		this.processes.delete(processId);
	}

	clear(): void {
		this.processes.clear();
	}
}
