import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { CodingRuntime } from "../core/coding-runtime.ts";
import { CodingRuntimeController } from "../core/coding-runtime-controller.ts";

export interface CodingPrintModeOptions {
	mode: "text" | "json";
	initialMessage?: string;
	initialInput?: string | AgentMessage;
	messages?: readonly string[];
	signal?: AbortSignal;
	write?: (text: string) => void;
	writeError?: (text: string) => void;
}

/** Run the canonical Coding Runtime as a finite CLI-style process. */
export async function runCodingPrintMode(runtime: CodingRuntime, options: CodingPrintModeOptions): Promise<number> {
	const write = options.write ?? ((text: string) => process.stdout.write(text));
	const writeError = options.writeError ?? ((text: string) => process.stderr.write(text));
	const controller = await CodingRuntimeController.create(runtime);
	const unsubscribe =
		options.mode === "json" ? controller.onAgentEvent((event) => write(`${JSON.stringify(event)}\n`)) : undefined;
	const projection = options.mode === "json" ? controller.projection : undefined;
	const unsubscribeProjection = projection?.subscribe(
		(snapshot) => write(`${JSON.stringify({ type: "runtime_snapshot", snapshot })}\n`),
		false,
	);
	const onAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		if (options.mode === "json") {
			write(
				`${JSON.stringify({ type: "session", profileId: runtime.profile.id, sessionPath: runtime.sessionPath })}\n`,
			);
			write(`${JSON.stringify({ type: "runtime_snapshot", snapshot: projection!.snapshot })}\n`);
		}
		for (const message of [options.initialInput ?? options.initialMessage, ...(options.messages ?? [])]) {
			if (message === undefined || (typeof message === "string" && message.length === 0)) continue;
			const command = typeof message === "string" ? parseLegacyCommand(controller, message) : undefined;
			if (command) {
				await controller.invokeCommand(command.name, command.args);
			} else await controller.send(message, "prompt");
		}
		if (options.mode === "text") {
			const lastMessage = controller.snapshot.projection.messages.at(-1);
			if (lastMessage?.role === "assistant") {
				const assistant = lastMessage as AssistantMessage;
				if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
					writeError(`${assistant.errorMessage ?? `Request ${assistant.stopReason}`}\n`);
					return 1;
				}
				for (const part of assistant.content) {
					if (part.type === "text") write(`${part.text}\n`);
				}
			}
		}
		return 0;
	} catch (error) {
		writeError(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		unsubscribe?.();
		await projection?.settle();
		unsubscribeProjection?.();
		await controller.dispose();
	}
}

function parseLegacyCommand(
	controller: CodingRuntimeController,
	message: string,
): { name: string; args: string } | undefined {
	if (!message.startsWith("/")) return undefined;
	const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(message.trim());
	if (!match) return undefined;
	const command = controller.commands.find((candidate) => candidate.name === match[1]);
	return command ? { name: command.name, args: match[2] ?? "" } : undefined;
}
