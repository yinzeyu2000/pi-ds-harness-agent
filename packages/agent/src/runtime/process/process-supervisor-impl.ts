import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { asProcessId, type ProcessId, type ThreadId, type TurnId } from "@earendil-works/pi-protocol";
import type { ProcessHandle, ProcessOutcome, ProcessSpec, ProcessSupervisor } from "../types/providers.ts";
import { BoundedOutputBuffer, type OutputBatch, type ReadBufferOptions } from "./output-buffer.ts";
import { type ProcessRecord, ProcessRegistry } from "./process-registry.ts";

interface ActiveProcessState {
	readonly record: ProcessRecord;
	readonly child: ChildProcess;
	readonly exitPromise: Promise<ProcessOutcome>;
	timedOut: boolean;
	aborted: boolean;
	exitCode?: number;
	signal?: string;
	timeoutTimer?: NodeJS.Timeout;
}

export class ProcessSupervisorImpl implements ProcessSupervisor {
	readonly registry: ProcessRegistry;
	private readonly active = new Map<string, ActiveProcessState>();
	private processCounter = 1;

	constructor(registry?: ProcessRegistry) {
		this.registry = registry ?? new ProcessRegistry();
	}

	async spawn(
		spec: ProcessSpec,
		signalOrContext?: AbortSignal | { threadId?: ThreadId; turnId?: TurnId; signal?: AbortSignal },
	): Promise<ProcessHandle> {
		const processId = asProcessId(`proc_${Date.now()}_${this.processCounter++}`);
		const maxOutputBytes = spec.limits?.maxOutputBytes ?? 512 * 1024;
		const buffer = new BoundedOutputBuffer(maxOutputBytes);

		let threadId: ThreadId = "th_proc" as ThreadId;
		let turnId: TurnId | undefined;
		let signal: AbortSignal | undefined;

		if (signalOrContext instanceof AbortSignal) {
			signal = signalOrContext;
		} else if (signalOrContext) {
			if (signalOrContext.threadId) threadId = signalOrContext.threadId;
			if (signalOrContext.turnId) turnId = signalOrContext.turnId;
			if (signalOrContext.signal) signal = signalOrContext.signal;
		}

		const record: ProcessRecord = {
			processId,
			threadId,
			turnId,
			ownership: "foreground",
			status: "starting",
			startedAt: Date.now(),
			buffer,
		};
		this.registry.register(record);

		// Spawn child process
		const child = spawn(spec.command, spec.args, {
			cwd: spec.cwd,
			env: { ...process.env, ...spec.env },
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
		});

		record.status = "running";

		let resolveExit: (outcome: ProcessOutcome) => void;
		const exitPromise = new Promise<ProcessOutcome>((resolve) => {
			resolveExit = resolve;
		});

		const state: ActiveProcessState = {
			record,
			child,
			exitPromise,
			timedOut: false,
			aborted: false,
		};
		this.active.set(processId, state);

		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					void this.terminate(processId);
				},
				{ once: true },
			);
		}

		// Wire stdout and stderr into bounded ring buffer
		if (child.stdout) {
			child.stdout.on("data", (chunk: Buffer) => {
				buffer.append(chunk, "stdout");
			});
		}

		if (child.stderr) {
			child.stderr.on("data", (chunk: Buffer) => {
				buffer.append(chunk, "stderr");
			});
		}

		// Handle process exit
		child.on("close", (code, signalStr) => {
			if (state.timeoutTimer) {
				clearTimeout(state.timeoutTimer);
			}
			buffer.close();

			state.exitCode = code ?? undefined;
			state.signal = signalStr ?? undefined;

			const outcome: ProcessOutcome = {
				exitCode: state.exitCode,
				signal: state.signal,
				timedOut: state.timedOut,
				aborted: state.aborted,
				sandboxDenied: false,
				outputTruncated: buffer.truncated,
				terminationFailed: false,
			};

			record.outcome = outcome;
			record.status = state.timedOut ? "timed_out" : state.aborted ? "killed" : code === 0 ? "exited" : "failed";

			resolveExit(outcome);
		});

		child.on("error", (err) => {
			buffer.append(`Process error: ${err.message}\n`, "stderr");
		});

		// Timeout handling
		if (spec.timeoutMs && spec.timeoutMs > 0) {
			state.timeoutTimer = setTimeout(() => {
				state.timedOut = true;
				void this.terminate(processId);
			}, spec.timeoutMs);
		}

		const handle: ProcessHandle = {
			processId,
			read: (options) => this.read(processId, options),
			write: (data) => this.write(processId, data),
			resize: (cols, rows) => this.resize(processId, cols, rows),
			interrupt: () => this.interrupt(processId),
			terminate: () => this.terminate(processId),
			wait: () => exitPromise,
		};

		record.handle = handle;
		return handle;
	}

	get(processId: ProcessId): ProcessHandle | undefined {
		return this.registry.get(processId)?.handle;
	}

	list(): readonly ProcessId[] {
		return Array.from(this.active.keys()) as ProcessId[];
	}

	async read(processId: ProcessId, options?: ReadBufferOptions): Promise<OutputBatch> {
		const state = this.active.get(processId);
		if (!state) {
			const record = this.registry.get(processId);
			if (record) {
				return record.buffer.read(options);
			}
			throw new Error(`Process not found: ${processId}`);
		}
		return state.record.buffer.read(options);
	}

	async write(processId: ProcessId, input: Uint8Array): Promise<void> {
		const state = this.active.get(processId);
		if (!state || !state.child.stdin || state.child.stdin.destroyed) {
			throw new Error(`Cannot write to dead or terminating process: ${processId}`);
		}
		await new Promise<void>((resolve, reject) => {
			state.child.stdin!.write(input, (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
	}

	async resize(_processId: ProcessId, _cols: number, _rows: number): Promise<void> {
		// Non-PTY child processes do not support terminal resize
	}

	async interrupt(processId: ProcessId): Promise<void> {
		const state = this.active.get(processId);
		if (!state) return;
		state.aborted = true;
		try {
			state.child.kill("SIGINT");
		} catch {
			// Best effort interrupt
		}
	}

	async terminate(processId: ProcessId): Promise<ProcessOutcome> {
		const state = this.active.get(processId);
		if (!state) {
			const record = this.registry.get(processId);
			if (record?.outcome) {
				return record.outcome;
			}
			throw new Error(`Process not found for termination: ${processId}`);
		}

		if (state.record.outcome) {
			return state.record.outcome;
		}

		state.aborted = true;

		// 1. Send SIGTERM first (graceful)
		try {
			state.child.kill("SIGTERM");
		} catch {
			// Ignore
		}

		// 2. Wait grace period for exit
		const exitedGracefully = await Promise.race([
			state.exitPromise.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
		]);

		if (exitedGracefully && state.record.outcome) {
			return state.record.outcome;
		}

		// 3. Force SIGKILL
		try {
			state.child.kill("SIGKILL");
		} catch {
			// Ignore
		}

		// 4. Await exit confirmation with a strict deadline
		const finalExit = await Promise.race([
			state.exitPromise.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
		]);

		if (finalExit && state.record.outcome) {
			return state.record.outcome;
		}

		// Termination failed to be confirmed within deadline
		const failedOutcome: ProcessOutcome = {
			timedOut: state.timedOut,
			aborted: true,
			sandboxDenied: false,
			outputTruncated: state.record.buffer.truncated,
			terminationFailed: true,
		};
		state.record.outcome = failedOutcome;
		state.record.status = "unknown";
		return failedOutcome;
	}
}
