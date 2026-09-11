import type { ApprovalService, ToolRequest } from "@pi-ds/harness-runtime";

export type HarnessApprovalPrompt = (message: string, signal?: AbortSignal) => boolean | Promise<boolean>;

export function createInteractiveHarnessApproval(prompt: HarnessApprovalPrompt): ApprovalService<unknown> {
	return {
		async requestApproval(request, signal) {
			if (signal?.aborted) return { decision: "deny", reason: "Tool approval was aborted" };
			const allowed = await prompt(formatHarnessApprovalPrompt(request), signal);
			if (signal?.aborted) return { decision: "deny", reason: "Tool approval was aborted" };
			return allowed ? { decision: "allow" } : { decision: "deny", reason: `User denied tool ${request.name}` };
		},
	};
}

export function formatHarnessApprovalPrompt(request: ToolRequest<unknown>): string {
	return `Allow tool ${request.name} with arguments ${formatArguments(request.args)}?`;
}

function formatArguments(args: unknown): string {
	const serialized = JSON.stringify(args);
	if (serialized === undefined) return String(args);
	const limit = 2_000;
	return serialized.length <= limit ? serialized : `${serialized.slice(0, limit)}…`;
}
