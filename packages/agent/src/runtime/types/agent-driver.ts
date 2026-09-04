import type { ThreadId, TurnId } from "@earendil-works/pi-protocol";

export interface DriverRunOptions {
	readonly threadId: ThreadId;
	readonly turnId: TurnId;
	readonly input: unknown;
	readonly signal: AbortSignal;
}

export interface DriverRunResult {
	readonly turnId: TurnId;
	readonly outcome: "completed" | "interrupted" | "failed";
	readonly message?: string;
}

export interface AgentDriver {
	readonly name: string;
	run(options: DriverRunOptions): Promise<DriverRunResult>;
}

export class FakeDriver implements AgentDriver {
	readonly name = "FakeDriver";
	private readonly expectedOutcome: "completed" | "interrupted" | "failed";
	private readonly message?: string;

	constructor(expectedOutcome: "completed" | "interrupted" | "failed" = "completed", message?: string) {
		this.expectedOutcome = expectedOutcome;
		this.message = message;
	}

	async run(options: DriverRunOptions): Promise<DriverRunResult> {
		if (options.signal.aborted) {
			return { turnId: options.turnId, outcome: "interrupted", message: "Driver run aborted" };
		}
		return {
			turnId: options.turnId,
			outcome: this.expectedOutcome,
			message: this.message,
		};
	}
}
