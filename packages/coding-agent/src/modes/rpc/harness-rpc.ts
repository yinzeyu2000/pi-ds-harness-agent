import type { AgentEvent, CompactionEntry } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { CodingRuntime } from "../../core/coding-runtime.ts";
import { CodingRuntimeController, type CodingRuntimeDelivery } from "../../core/coding-runtime-controller.ts";
import type { CodingRuntimeHost } from "../../core/coding-runtime-host.ts";
import type { CodingRuntimeSnapshot } from "../../core/coding-runtime-projection.ts";
import type { HarnessRpcApprovalRequestEvent, HarnessRpcApprovalService } from "./harness-rpc-approval.ts";

export type HarnessRpcCommand =
	| { id?: string; type: "prompt"; message: string }
	| { id?: string; type: "steer"; message: string }
	| { id?: string; type: "follow_up"; message: string }
	| { id?: string; type: "abort" }
	| { id?: string; type: "resume" }
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "get_snapshot" }
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_commands" }
	| { id?: string; type: "invoke_command"; name: string; args?: string }
	| { id?: string; type: "get_recovery" }
	| { id?: string; type: "get_tree" }
	| { id?: string; type: "navigate"; entryId: string | null }
	| { id?: string; type: "fork_session"; sessionId?: string; entryId?: string; position?: "before" | "at" }
	| { id?: string; type: "switch_session"; sessionId: string }
	| { id?: string; type: "fork_and_switch"; sessionId?: string; entryId?: string; position?: "before" | "at" }
	| { id?: string; type: "set_active_tools"; names: string[] }
	| { id?: string; type: "set_model"; provider: string; model: string }
	| {
			id?: string;
			type: "set_thinking_level";
			level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	  }
	| { id?: string; type: "approval_response"; requestId: string; decision: "allow" | "deny"; reason?: string }
	| { id?: string; type: "shutdown" }
	| { id?: string; type: "set_session_name"; name: string };

export type HarnessRpcResponse =
	| { id?: string; type: "response"; command: HarnessRpcCommand["type"]; success: true; data?: unknown }
	| { id?: string; type: "response"; command: string; success: false; error: string };

export type HarnessRpcEvent =
	| { type: "runtime_snapshot"; snapshot: CodingRuntimeSnapshot }
	| { type: "agent_event"; event: AgentEvent }
	| HarnessRpcApprovalRequestEvent
	| { type: "runtime_error"; operation: string; error: string };

export type HarnessRpcEventSink = (event: HarnessRpcEvent) => void | Promise<void>;

export interface HarnessRpcSessionOptions {
	approval?: HarnessRpcApprovalService;
	resolveModel?: (provider: string, model: string) => Model<Api> | undefined | Promise<Model<Api> | undefined>;
}

/** Transport-independent RPC command dispatcher over the canonical Runtime Controller. */
export class HarnessRpcSession {
	private controller: CodingRuntimeController;
	private readonly host?: CodingRuntimeHost;
	private readonly sink: HarnessRpcEventSink;
	private readonly approval?: HarnessRpcApprovalService;
	private readonly resolveModel?: HarnessRpcSessionOptions["resolveModel"];
	private readonly pending = new Set<Promise<void>>();
	private readonly unsubscribers: Array<() => void>;
	private startPending = false;
	private shutdownRequested = false;
	private disposed = false;

	private constructor(
		controller: CodingRuntimeController,
		sink: HarnessRpcEventSink,
		options: HarnessRpcSessionOptions,
		host?: CodingRuntimeHost,
	) {
		this.controller = controller;
		this.host = host;
		this.sink = sink;
		this.approval = options.approval;
		this.resolveModel = options.resolveModel;
		this.unsubscribers = host
			? [
					host.subscribe((snapshot) => sink({ type: "runtime_snapshot", snapshot }), false),
					host.onAgentEvent((event) => sink({ type: "agent_event", event })),
					host.onReplaced(() => {
						this.controller = host.controller;
					}),
				]
			: [
					controller.subscribe((snapshot) => sink({ type: "runtime_snapshot", snapshot }), false),
					controller.onAgentEvent((event) => sink({ type: "agent_event", event })),
				];
		if (options.approval) this.unsubscribers.push(options.approval.bind(sink));
	}

	static async create(
		runtime: CodingRuntime,
		sink: HarnessRpcEventSink,
		options: HarnessRpcSessionOptions = {},
	): Promise<HarnessRpcSession> {
		const controller = await CodingRuntimeController.create(runtime);
		const session = new HarnessRpcSession(controller, sink, options);
		await sink({ type: "runtime_snapshot", snapshot: controller.snapshot });
		return session;
	}

	static async createHosted(
		host: CodingRuntimeHost,
		sink: HarnessRpcEventSink,
		options: HarnessRpcSessionOptions = {},
	): Promise<HarnessRpcSession> {
		const session = new HarnessRpcSession(host.controller, sink, options, host);
		await sink({ type: "runtime_snapshot", snapshot: host.snapshot });
		return session;
	}

	async handle(command: HarnessRpcCommand): Promise<HarnessRpcResponse> {
		this.assertActive();
		try {
			switch (command.type) {
				case "prompt":
					return this.start(command, "prompt");
				case "steer":
					await this.controller.send(command.message, "steer");
					return success(command);
				case "follow_up":
					await this.controller.send(command.message, "followUp");
					return success(command);
				case "abort":
					this.controller.abort();
					return success(command);
				case "resume":
					this.track("resume", this.controller.resume());
					return success(command);
				case "compact": {
					const entry = await this.controller.compact(command.customInstructions);
					return success(command, entry ?? null);
				}
				case "get_snapshot":
					return success(command, this.controller.snapshot);
				case "get_messages":
					return success(command, { messages: this.controller.snapshot.projection.messages });
				case "get_commands":
					return success(command, { commands: this.controller.commands });
				case "invoke_command":
					await this.controller.invokeCommand(command.name, command.args);
					return success(command);
				case "get_recovery":
					return success(command, await this.controller.getRecoveryState());
				case "get_tree":
					return success(command, await this.controller.getTree());
				case "navigate":
					await this.controller.navigateTo(command.entryId);
					return success(command);
				case "fork_session":
					return success(
						command,
						await this.controller.forkSession({
							...(command.sessionId === undefined ? {} : { id: command.sessionId }),
							...(command.entryId === undefined ? {} : { entryId: command.entryId }),
							...(command.position === undefined ? {} : { position: command.position }),
						}),
					);
				case "switch_session":
					if (!this.host) throw new Error("Harness RPC session switching requires a Coding Runtime Host");
					return success(command, await this.host.switchSession(command.sessionId));
				case "fork_and_switch":
					if (!this.host) throw new Error("Harness RPC fork-and-switch requires a Coding Runtime Host");
					return success(
						command,
						await this.host.forkAndSwitch({
							...(command.sessionId === undefined ? {} : { id: command.sessionId }),
							...(command.entryId === undefined ? {} : { entryId: command.entryId }),
							...(command.position === undefined ? {} : { position: command.position }),
						}),
					);
				case "set_active_tools":
					await this.controller.setActiveTools(command.names);
					return success(command);
				case "set_model": {
					if (!this.resolveModel) throw new Error("Harness RPC model resolver is not configured");
					const model = await this.resolveModel(command.provider, command.model);
					if (!model) throw new Error(`Model is not available: ${command.provider}/${command.model}`);
					await this.controller.setModel(model);
					return success(command);
				}
				case "set_thinking_level":
					await this.controller.setThinkingLevel(command.level);
					return success(command);
				case "approval_response":
					if (!this.approval) throw new Error("Harness RPC approval service is not configured");
					this.approval.respond(
						command.requestId,
						command.decision === "allow"
							? { decision: "allow" }
							: { decision: "deny", reason: command.reason ?? "RPC client denied tool approval" },
					);
					return success(command);
				case "shutdown":
					this.shutdownRequested = true;
					this.controller.abort();
					return success(command);
				case "set_session_name":
					await this.controller.setSessionName(command.name);
					return success(command);
			}
		} catch (error) {
			return failure(command, error);
		}
	}

	get shouldShutdown(): boolean {
		return this.shutdownRequested;
	}

	async waitForIdle(): Promise<void> {
		this.assertActive();
		await this.controller.waitForIdle();
		while (this.pending.size > 0) await Promise.all([...this.pending]);
		await this.controller.projection.settle();
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		for (const unsubscribe of this.unsubscribers) unsubscribe();
		this.controller.abort();
		await Promise.all([...this.pending]);
		this.approval?.close();
		if (this.host) await this.host.dispose();
		else await this.controller.dispose();
	}

	private start(
		command: Extract<HarnessRpcCommand, { type: "prompt" }>,
		delivery: CodingRuntimeDelivery,
	): HarnessRpcResponse {
		if (this.startPending || this.controller.snapshot.projection.turnState.operation) {
			return failure(command, new Error("Runtime is already processing a prompt"));
		}
		this.startPending = true;
		this.track(command.type, this.controller.send(command.message, delivery), () => {
			this.startPending = false;
		});
		return success(command);
	}

	private track(operation: string, task: Promise<void>, onSettled?: () => void): void {
		const tracked = task
			.catch((error) =>
				this.sink({
					type: "runtime_error",
					operation,
					error: error instanceof Error ? error.message : String(error),
				}),
			)
			.then(() => undefined)
			.finally(() => {
				onSettled?.();
				this.pending.delete(tracked);
			});
		this.pending.add(tracked);
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("Harness RPC session is disposed");
	}
}

function success(
	command: HarnessRpcCommand,
	data?: CompactionEntry | CodingRuntimeSnapshot | object | null,
): HarnessRpcResponse {
	return data === undefined
		? { id: command.id, type: "response", command: command.type, success: true }
		: { id: command.id, type: "response", command: command.type, success: true, data };
}

function failure(command: Pick<HarnessRpcCommand, "id" | "type">, error: unknown): HarnessRpcResponse {
	return {
		id: command.id,
		type: "response",
		command: command.type,
		success: false,
		error: error instanceof Error ? error.message : String(error),
	};
}
