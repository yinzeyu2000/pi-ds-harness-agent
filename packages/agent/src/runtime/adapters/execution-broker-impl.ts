import type { AgentTool } from "../../types.ts";
import type {
	ActionKind,
	ExecutionBroker,
	PreparedAction,
	ToolAttemptCoordinator,
	ToolExecutionContext,
	ToolExecutionOutcome,
} from "../types/execution-broker.ts";
import type { ProcessOutcome, ProcessSpec, ProcessSupervisor } from "../types/providers.ts";

export interface ExecutionBrokerOptions {
	readonly coordinator?: ToolAttemptCoordinator;
	readonly supervisor?: ProcessSupervisor;
	readonly tools?: ReadonlyMap<string, AgentTool>;
	readonly policyChecker?: (action: PreparedAction, context: ToolExecutionContext) => Promise<boolean> | boolean;
}

export class ExecutionBrokerImpl implements ExecutionBroker {
	private readonly coordinator?: ToolAttemptCoordinator;
	private readonly supervisor?: ProcessSupervisor;
	private readonly tools: Map<string, AgentTool>;
	private readonly policyChecker?: (
		action: PreparedAction,
		context: ToolExecutionContext,
	) => Promise<boolean> | boolean;

	constructor(options?: ExecutionBrokerOptions) {
		this.coordinator = options?.coordinator;
		this.supervisor = options?.supervisor;
		this.tools = new Map(options?.tools ?? []);
		this.policyChecker = options?.policyChecker;
	}

	registerTool(tool: AgentTool): void {
		this.tools.set(tool.name, tool);
	}

	async prepareAction(toolName: string, input: unknown, _context: ToolExecutionContext): Promise<PreparedAction> {
		let kind: ActionKind = "compute";

		if (toolName === "bash" || toolName === "shell" || toolName === "exec") {
			kind = "process";
		} else if (toolName.includes("read") || toolName.includes("grep") || toolName.includes("find")) {
			kind = "fs_read";
		} else if (toolName.includes("write") || toolName.includes("edit") || toolName.includes("replace")) {
			kind = "fs_write";
		}

		return {
			kind,
			toolName,
			payload: input,
		};
	}

	async executeAction(action: PreparedAction, context: ToolExecutionContext): Promise<ToolExecutionOutcome> {
		const start = Date.now();

		// Step 1: Attempt prepared
		if (this.coordinator) {
			await this.coordinator.onAttemptPrepared(context.toolAttemptId, action);
		}

		// Step 2: Policy / Approval check
		if (this.policyChecker) {
			const allowed = await this.policyChecker(action, context);
			if (!allowed) {
				const deniedOutcome: ToolExecutionOutcome = {
					toolAttemptId: context.toolAttemptId,
					status: "denied",
					error: "Action denied by security policy or approval",
					durationMs: Date.now() - start,
				};
				if (this.coordinator) {
					await this.coordinator.onAttemptSettled(context.toolAttemptId, deniedOutcome);
				}
				return deniedOutcome;
			}
		}

		// Step 3: Write-before-execute barrier
		if (this.coordinator) {
			await this.coordinator.onDispatchIntent(context.toolAttemptId);
		}

		// Step 4: Execution started
		if (this.coordinator) {
			await this.coordinator.onExecutionStarted(context.toolAttemptId);
		}

		try {
			let output: unknown;

			// Step 5: Route to ProcessSupervisor or AgentTool
			if (action.kind === "process" && this.supervisor) {
				const params = action.payload as any;
				let spec: ProcessSpec;

				if (params?.command && Array.isArray(params.args)) {
					spec = {
						command: params.command,
						args: params.args,
						cwd: params.cwd,
						timeoutMs: params.timeoutMs,
					};
				} else {
					const commandStr: string = params?.command ?? params?.cmd ?? String(params ?? "");
					spec = {
						command: process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh",
						args: process.platform === "win32" ? ["/d", "/s", "/c", commandStr] : ["-c", commandStr],
						cwd: params?.cwd,
						timeoutMs: params?.timeoutMs,
					};
				}

				const handle = await this.supervisor.spawn(spec, context.signal);

				const processOutcome: ProcessOutcome = await handle.wait();
				const outputBatch = await this.supervisor.read(handle.processId);
				const stdoutText = outputBatch.chunks
					.filter((c: any) => c.stream === "stdout")
					.map((c: any) => c.data)
					.join("");
				const stderrText = outputBatch.chunks
					.filter((c: any) => c.stream === "stderr")
					.map((c: any) => c.data)
					.join("");

				output = {
					stdout: stdoutText,
					stderr: stderrText,
					exitCode: processOutcome.exitCode,
					timedOut: processOutcome.timedOut,
					aborted: processOutcome.aborted,
				};
			} else {
				const tool = this.tools.get(action.toolName);
				if (!tool) {
					throw new Error(`Tool ${action.toolName} not registered in ExecutionBroker`);
				}
				output = await tool.execute(context.toolCallId, action.payload, context.signal);
			}

			const successOutcome: ToolExecutionOutcome = {
				toolAttemptId: context.toolAttemptId,
				status: "completed",
				output,
				durationMs: Date.now() - start,
			};

			if (this.coordinator) {
				await this.coordinator.onAttemptSettled(context.toolAttemptId, successOutcome);
			}

			return successOutcome;
		} catch (err: any) {
			const failedOutcome: ToolExecutionOutcome = {
				toolAttemptId: context.toolAttemptId,
				status: "failed",
				error: err instanceof Error ? err.message : String(err),
				durationMs: Date.now() - start,
			};

			if (this.coordinator) {
				await this.coordinator.onAttemptSettled(context.toolAttemptId, failedOutcome);
			}

			return failedOutcome;
		}
	}
}
