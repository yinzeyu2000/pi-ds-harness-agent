import type {
	ExecutionBroker,
	PreparedAction,
	ToolAttemptCoordinator,
	ToolExecutionContext,
	ToolExecutionOutcome,
} from "../types/execution-broker.ts";

export type InProcessToolHandler = (input: unknown, context: ToolExecutionContext) => Promise<unknown> | unknown;

export class MemoryExecutionBroker implements ExecutionBroker {
	private readonly handlers = new Map<string, InProcessToolHandler>();
	private coordinator?: ToolAttemptCoordinator;

	constructor(coordinator?: ToolAttemptCoordinator) {
		this.coordinator = coordinator;
	}

	setCoordinator(coordinator: ToolAttemptCoordinator): void {
		this.coordinator = coordinator;
	}

	registerTool(name: string, handler: InProcessToolHandler): void {
		this.handlers.set(name, handler);
	}

	async prepareAction(toolName: string, input: unknown, _context: ToolExecutionContext): Promise<PreparedAction> {
		return {
			kind: "compute",
			toolName,
			payload: input,
		};
	}

	async executeAction(action: PreparedAction, context: ToolExecutionContext): Promise<ToolExecutionOutcome> {
		const startTime = Date.now();

		if (this.coordinator) {
			await this.coordinator.onAttemptPrepared(context.toolAttemptId, action);
			await this.coordinator.onDispatchIntent(context.toolAttemptId);
			await this.coordinator.onExecutionStarted(context.toolAttemptId);
		}

		const handler = this.handlers.get(action.toolName);
		if (!handler) {
			const outcome: ToolExecutionOutcome = {
				toolAttemptId: context.toolAttemptId,
				status: "failed",
				error: `Tool ${action.toolName} not found in broker`,
				durationMs: Date.now() - startTime,
			};
			if (this.coordinator) {
				await this.coordinator.onAttemptSettled(context.toolAttemptId, outcome);
			}
			return outcome;
		}

		try {
			if (context.signal.aborted) {
				const outcome: ToolExecutionOutcome = {
					toolAttemptId: context.toolAttemptId,
					status: "failed",
					error: "Tool execution aborted",
					durationMs: Date.now() - startTime,
				};
				if (this.coordinator) {
					await this.coordinator.onAttemptSettled(context.toolAttemptId, outcome);
				}
				return outcome;
			}

			const result = await handler(action.payload, context);
			const outcome: ToolExecutionOutcome = {
				toolAttemptId: context.toolAttemptId,
				status: "completed",
				output: result,
				durationMs: Date.now() - startTime,
			};
			if (this.coordinator) {
				await this.coordinator.onAttemptSettled(context.toolAttemptId, outcome);
			}
			return outcome;
		} catch (error) {
			const outcome: ToolExecutionOutcome = {
				toolAttemptId: context.toolAttemptId,
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - startTime,
			};
			if (this.coordinator) {
				await this.coordinator.onAttemptSettled(context.toolAttemptId, outcome);
			}
			return outcome;
		}
	}
}
