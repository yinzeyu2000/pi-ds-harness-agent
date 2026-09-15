import { resolve } from "node:path";
import type { AgentEvent, CompactionEntry, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { CodingRuntime } from "../../core/coding-runtime.ts";
import { CodingRuntimeController, type CodingRuntimeDelivery } from "../../core/coding-runtime-controller.ts";
import type { CodingRuntimeHost } from "../../core/coding-runtime-host.ts";
import type { CodingRuntimeSnapshot } from "../../core/coding-runtime-projection.ts";
import type { HarnessRpcApprovalRequestEvent, HarnessRpcApprovalService } from "./harness-rpc-approval.ts";
import type { HarnessRpcExtensionUIService } from "./harness-rpc-extension-ui.ts";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "./rpc-types.ts";

export type HarnessRpcCommand =
	| { id?: string; type: "prompt"; message: string }
	| { id?: string; type: "steer"; message: string }
	| { id?: string; type: "follow_up"; message: string }
	| { id?: string; type: "abort" }
	| { id?: string; type: "clear_queue" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "resume" }
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "get_snapshot" }
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "get_entries"; since?: string }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "clone"; sessionId?: string }
	| { id?: string; type: "get_commands" }
	| { id?: string; type: "new_session"; sessionId?: string; parentSession?: string }
	| { id?: string; type: "get_available_models" }
	| { id?: string; type: "get_available_thinking_levels" }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "invoke_command"; name: string; args?: string }
	| { id?: string; type: "get_recovery" }
	| { id?: string; type: "get_tree" }
	| {
			id?: string;
			type: "navigate";
			entryId: string | null;
			summarize?: boolean;
			customInstructions?: string;
			label?: string;
	  }
	| { id?: string; type: "fork_session"; sessionId?: string; entryId?: string; position?: "before" | "at" }
	| { id?: string; type: "switch_session"; sessionId: string; cwd?: string }
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
	| { id?: string; type: "set_session_name"; name: string }
	| RpcExtensionUIResponse;

export type HarnessRpcResponse =
	| { id?: string; type: "response"; command: HarnessRpcCommand["type"]; success: true; data?: unknown }
	| { id?: string; type: "response"; command: string; success: false; error: string };

export type HarnessRpcEvent =
	| { type: "runtime_snapshot"; snapshot: CodingRuntimeSnapshot }
	| { type: "agent_event"; event: AgentEvent }
	| HarnessRpcApprovalRequestEvent
	| RpcExtensionUIRequest
	| { type: "runtime_error"; operation: string; error: string };

export type HarnessRpcEventSink = (event: HarnessRpcEvent) => void | Promise<void>;

export interface HarnessRpcSessionOptions {
	approval?: HarnessRpcApprovalService;
	resolveModel?: (provider: string, model: string) => Model<Api> | undefined | Promise<Model<Api> | undefined>;
	listModels?: () => readonly Model<Api>[] | Promise<readonly Model<Api>[]>;
	modelsScoped?: boolean;
	extensionUI?: HarnessRpcExtensionUIService;
	onModelChanged?: (model: Model<Api>) => void | Promise<void>;
	onThinkingLevelChanged?: (level: ThinkingLevel) => void | Promise<void>;
	onToolsChanged?: (names: readonly string[]) => void | Promise<void>;
}

/** Transport-independent RPC command dispatcher over the canonical Runtime Controller. */
export class HarnessRpcSession {
	private controller: CodingRuntimeController;
	private readonly host?: CodingRuntimeHost;
	private readonly sink: HarnessRpcEventSink;
	private readonly approval?: HarnessRpcApprovalService;
	private readonly resolveModel?: HarnessRpcSessionOptions["resolveModel"];
	private readonly listModels?: HarnessRpcSessionOptions["listModels"];
	private readonly modelsScoped: boolean;
	private readonly extensionUI?: HarnessRpcExtensionUIService;
	private readonly onModelChanged?: HarnessRpcSessionOptions["onModelChanged"];
	private readonly onThinkingLevelChanged?: HarnessRpcSessionOptions["onThinkingLevelChanged"];
	private readonly onToolsChanged?: HarnessRpcSessionOptions["onToolsChanged"];
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
		this.listModels = options.listModels;
		this.modelsScoped = options.modelsScoped ?? false;
		this.extensionUI = options.extensionUI;
		this.onModelChanged = options.onModelChanged;
		this.onThinkingLevelChanged = options.onThinkingLevelChanged;
		this.onToolsChanged = options.onToolsChanged;
		this.unsubscribers = host
			? [
					host.subscribe((snapshot) => sink({ type: "runtime_snapshot", snapshot }), false),
					host.onAgentEvent((event) => sink({ type: "agent_event", event })),
					host.onReplaced(() => {
						this.extensionUI?.cancelPending();
						this.controller = host.controller;
					}),
				]
			: [
					controller.subscribe((snapshot) => sink({ type: "runtime_snapshot", snapshot }), false),
					controller.onAgentEvent((event) => sink({ type: "agent_event", event })),
				];
		if (options.approval) this.unsubscribers.push(options.approval.bind(sink));
		if (options.extensionUI) this.unsubscribers.push(options.extensionUI.bind(sink));
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
				case "clear_queue":
					return success(command, await this.controller.clearQueue());
				case "export_html":
					return success(command, { path: await this.controller.exportHtml(command.outputPath) });
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
				case "get_session_stats":
					return success(command, await this.controller.getSessionStats());
				case "get_last_assistant_text":
					return success(command, { text: await this.controller.getLastAssistantText() });
				case "get_entries":
					return success(command, await this.controller.getEntries(command.since));
				case "get_fork_messages":
					return success(command, { messages: await this.controller.getForkMessages() });
				case "clone": {
					if (!this.host) throw new Error("Harness RPC clone requires a Coding Runtime Host");
					const { lanes } = await this.controller.getTree();
					const leafId = lanes.find(({ lane }) => lane === "main")?.leafId;
					if (!leafId) throw new Error("Cannot clone Session: no current entry selected");
					return success(
						command,
						await this.host.forkAndSwitch({
							entryId: leafId,
							position: "at",
							...(command.sessionId === undefined ? {} : { id: command.sessionId }),
						}),
					);
				}
				case "get_commands":
					return success(command, { commands: this.controller.commands });
				case "new_session": {
					if (!this.host) throw new Error("Harness RPC new Session requires a Coding Runtime Host");
					const parentSessionId = command.parentSession
						? (await this.resolveSession(command.parentSession)).id
						: undefined;
					return success(
						command,
						await this.host.newSession({
							cwd: this.host.snapshot.session.cwd,
							...(command.sessionId === undefined ? {} : { id: command.sessionId }),
							...(parentSessionId === undefined ? {} : { parentSessionId }),
						}),
					);
				}
				case "get_available_models":
					if (!this.listModels) throw new Error("Harness RPC model catalogue is not configured");
					return success(command, { models: await this.listModels() });
				case "get_available_thinking_levels":
					return success(command, { levels: getSupportedThinkingLevels(this.controller.driver.model) });
				case "cycle_model": {
					if (!this.listModels) throw new Error("Harness RPC model catalogue is not configured");
					const models = [...(await this.listModels())];
					if (models.length === 0) return success(command, null);
					const current = this.controller.driver.model;
					const currentIndex = models.findIndex(
						(model) => model.provider === current.provider && model.id === current.id,
					);
					const model = models[(currentIndex + 1) % models.length]!;
					await this.controller.setModel(model);
					await this.onModelChanged?.(model);
					return success(command, {
						model,
						thinkingLevel: this.controller.driver.thinkingLevel,
						isScoped: this.modelsScoped,
					});
				}
				case "cycle_thinking_level": {
					const levels = getSupportedThinkingLevels(this.controller.driver.model);
					const currentIndex = levels.indexOf(this.controller.driver.thinkingLevel);
					const level = levels[(currentIndex + 1) % levels.length]!;
					await this.controller.setThinkingLevel(level);
					await this.onThinkingLevelChanged?.(level);
					return success(command, { level });
				}
				case "invoke_command":
					await this.controller.invokeCommand(command.name, command.args);
					return success(command);
				case "get_recovery":
					return success(command, await this.controller.getRecoveryState());
				case "get_tree":
					return success(command, await this.controller.getTree());
				case "navigate":
					await this.controller.navigateTo(command.entryId, {
						summarize: command.summarize,
						customInstructions: command.customInstructions,
						label: command.label,
					});
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
					{
						const metadata = await this.resolveSession(command.sessionId, command.cwd);
						return success(command, await this.host.switchSession({ sessionId: metadata.id, cwd: metadata.cwd }));
					}
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
					await this.onToolsChanged?.(command.names);
					return success(command);
				case "set_model": {
					if (!this.resolveModel) throw new Error("Harness RPC model resolver is not configured");
					const model = await this.resolveModel(command.provider, command.model);
					if (!model) throw new Error(`Model is not available: ${command.provider}/${command.model}`);
					await this.controller.setModel(model);
					await this.onModelChanged?.(model);
					return success(command);
				}
				case "set_thinking_level":
					await this.controller.setThinkingLevel(command.level);
					await this.onThinkingLevelChanged?.(command.level);
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
				case "extension_ui_response":
					if (!this.extensionUI) throw new Error("Harness RPC Extension UI service is not configured");
					if (!this.extensionUI.respond(command)) throw new Error(`Extension UI request not found: ${command.id}`);
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
		this.extensionUI?.close();
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

	private async resolveSession(reference: string, cwd?: string) {
		const baseCwd = cwd ?? this.host?.snapshot.session.cwd;
		const resolvedReference = resolve(baseCwd ?? "", reference);
		const resolvedCwd = cwd === undefined ? undefined : resolve(cwd);
		const matches = (await this.controller.listSessions("all")).filter(
			(metadata) =>
				(metadata.id === reference || resolve(metadata.path) === resolvedReference) &&
				(resolvedCwd === undefined || resolve(metadata.cwd) === resolvedCwd),
		);
		if (matches.length === 1) return matches[0]!;
		if (matches.length > 1) {
			throw new Error(`Session id is ambiguous across projects; use its JSONL path: ${reference}`);
		}
		throw new Error(`Harness session was not found: ${reference}`);
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
