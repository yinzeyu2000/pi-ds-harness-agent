import type { Readable } from "node:stream";
import type { CodingRuntime } from "../../core/coding-runtime.ts";
import type { CodingRuntimeHost } from "../../core/coding-runtime-host.ts";
import { flushRawStdout, writeRawStdout } from "../../core/output-guard.ts";
import type { HarnessRpcSessionOptions } from "./harness-rpc.ts";
import { type HarnessRpcCommand, type HarnessRpcResponse, HarnessRpcSession } from "./harness-rpc.ts";
import type { HarnessRpcApprovalService } from "./harness-rpc-approval.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";

export interface HarnessRpcModeOptions {
	input?: Readable;
	write?: (text: string) => void | Promise<void>;
	flush?: () => void | Promise<void>;
	approval?: HarnessRpcApprovalService;
	resolveModel?: HarnessRpcSessionOptions["resolveModel"];
	host?: CodingRuntimeHost;
}

/** Run the canonical Harness control protocol over strict LF-delimited JSON. */
export async function runHarnessRpcMode(runtime: CodingRuntime, options: HarnessRpcModeOptions = {}): Promise<number> {
	const input = options.input ?? process.stdin;
	const write = options.write ?? writeRawStdout;
	const flush = options.flush ?? flushRawStdout;
	let outputTail = Promise.resolve();
	const output = (value: object): Promise<void> => {
		outputTail = outputTail.then(() => write(serializeJsonLine(value)));
		return outputTail;
	};
	const sessionOptions = { approval: options.approval, resolveModel: options.resolveModel };
	const rpc = options.host
		? await HarnessRpcSession.createHosted(options.host, output, sessionOptions)
		: await HarnessRpcSession.create(runtime, output, sessionOptions);
	let commandTail = Promise.resolve();
	let inputError: Error | undefined;
	let finishInput: () => void = () => undefined;
	const ended = new Promise<void>((resolve) => {
		finishInput = resolve;
		input.once("end", finishInput);
		input.once("error", (error) => {
			inputError = error;
			resolve();
		});
	});
	const detach = attachJsonlLineReader(input, (line) => {
		commandTail = commandTail.then(async () => {
			if (rpc.shouldShutdown) return;
			if (line.trim().length === 0) return;
			try {
				const command = parseHarnessRpcCommand(line);
				await output(await rpc.handle(command));
				if (rpc.shouldShutdown) finishInput();
			} catch (error) {
				await output(invalidCommandResponse(line, error));
			}
		});
	});

	try {
		await ended;
		await commandTail;
		if (inputError) throw inputError;
		options.approval?.close("Harness RPC input closed before approval was answered");
		await rpc.waitForIdle();
		await outputTail;
		await flush();
		return 0;
	} finally {
		detach();
		if (rpc.shouldShutdown) input.pause();
		await rpc.dispose();
		await outputTail;
		await flush();
	}
}

export function parseHarnessRpcCommand(line: string): HarnessRpcCommand {
	const parsed: unknown = JSON.parse(line);
	if (!isRecord(parsed)) throw new Error("RPC command must be a JSON object");
	if (parsed.id !== undefined && typeof parsed.id !== "string") throw new Error("RPC command id must be a string");
	if (typeof parsed.type !== "string") throw new Error("RPC command type must be a string");
	const id = parsed.id as string | undefined;
	switch (parsed.type) {
		case "prompt":
		case "steer":
		case "follow_up":
			if (typeof parsed.message !== "string") throw new Error(`${parsed.type} requires a string message`);
			return { ...(id === undefined ? {} : { id }), type: parsed.type, message: parsed.message };
		case "abort":
		case "resume":
		case "get_snapshot":
		case "get_messages":
		case "get_commands":
		case "get_recovery":
		case "get_tree":
		case "shutdown":
			return { ...(id === undefined ? {} : { id }), type: parsed.type };
		case "navigate":
			if (parsed.entryId !== null && typeof parsed.entryId !== "string") {
				throw new Error("navigate requires a string or null entryId");
			}
			return { ...(id === undefined ? {} : { id }), type: "navigate", entryId: parsed.entryId };
		case "fork_session":
		case "fork_and_switch":
			if (parsed.sessionId !== undefined && typeof parsed.sessionId !== "string") {
				throw new Error(`${parsed.type} sessionId must be a string`);
			}
			if (parsed.entryId !== undefined && typeof parsed.entryId !== "string") {
				throw new Error(`${parsed.type} entryId must be a string`);
			}
			if (parsed.position !== undefined && parsed.position !== "before" && parsed.position !== "at") {
				throw new Error(`${parsed.type} position must be "before" or "at"`);
			}
			return {
				...(id === undefined ? {} : { id }),
				type: parsed.type,
				...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
				...(parsed.entryId === undefined ? {} : { entryId: parsed.entryId }),
				...(parsed.position === undefined ? {} : { position: parsed.position }),
			};
		case "switch_session":
			if (typeof parsed.sessionId !== "string") throw new Error("switch_session requires a string sessionId");
			return { ...(id === undefined ? {} : { id }), type: "switch_session", sessionId: parsed.sessionId };
		case "invoke_command":
			if (typeof parsed.name !== "string") throw new Error("invoke_command requires a string name");
			if (parsed.args !== undefined && typeof parsed.args !== "string") {
				throw new Error("invoke_command args must be a string");
			}
			return {
				...(id === undefined ? {} : { id }),
				type: "invoke_command",
				name: parsed.name,
				...(parsed.args === undefined ? {} : { args: parsed.args }),
			};
		case "set_active_tools":
			if (!Array.isArray(parsed.names) || parsed.names.some((name) => typeof name !== "string")) {
				throw new Error("set_active_tools requires a string names array");
			}
			return { ...(id === undefined ? {} : { id }), type: "set_active_tools", names: [...parsed.names] };
		case "set_model":
			if (typeof parsed.provider !== "string" || typeof parsed.model !== "string") {
				throw new Error("set_model requires string provider and model values");
			}
			return {
				...(id === undefined ? {} : { id }),
				type: "set_model",
				provider: parsed.provider,
				model: parsed.model,
			};
		case "set_thinking_level":
			if (!isThinkingLevel(parsed.level)) {
				throw new Error("set_thinking_level requires a valid thinking level");
			}
			return { ...(id === undefined ? {} : { id }), type: "set_thinking_level", level: parsed.level };
		case "approval_response":
			if (typeof parsed.requestId !== "string") {
				throw new Error("approval_response requires a string requestId");
			}
			if (parsed.decision !== "allow" && parsed.decision !== "deny") {
				throw new Error('approval_response decision must be "allow" or "deny"');
			}
			if (parsed.reason !== undefined && typeof parsed.reason !== "string") {
				throw new Error("approval_response reason must be a string");
			}
			return {
				...(id === undefined ? {} : { id }),
				type: "approval_response",
				requestId: parsed.requestId,
				decision: parsed.decision,
				...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
			};
		case "compact":
			if (parsed.customInstructions !== undefined && typeof parsed.customInstructions !== "string") {
				throw new Error("compact customInstructions must be a string");
			}
			return {
				...(id === undefined ? {} : { id }),
				type: "compact",
				...(parsed.customInstructions === undefined ? {} : { customInstructions: parsed.customInstructions }),
			};
		case "set_session_name":
			if (typeof parsed.name !== "string") throw new Error("set_session_name requires a string name");
			return { ...(id === undefined ? {} : { id }), type: "set_session_name", name: parsed.name };
		default:
			throw new Error(`Unknown Harness RPC command: ${parsed.type}`);
	}
}

function invalidCommandResponse(line: string, error: unknown): HarnessRpcResponse {
	let id: string | undefined;
	let command = "invalid";
	try {
		const parsed: unknown = JSON.parse(line);
		if (isRecord(parsed)) {
			if (typeof parsed.id === "string") id = parsed.id;
			if (typeof parsed.type === "string") command = parsed.type;
		}
	} catch {
		// The original parsing error below is more useful to the client.
	}
	return {
		...(id === undefined ? {} : { id }),
		type: "response",
		command,
		success: false,
		error: error instanceof Error ? error.message : String(error),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
	return typeof value === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}
