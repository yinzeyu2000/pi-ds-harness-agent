import type { ApprovalDecision, ApprovalService, ToolRequest } from "@pi-ds/harness-runtime";

export interface HarnessRpcApprovalRequestEvent {
	type: "approval_request";
	request: ToolRequest<unknown>;
}

type ApprovalSink = (event: HarnessRpcApprovalRequestEvent) => void | Promise<void>;

/** Approval service whose pending requests are completed by Harness RPC commands. */
export class HarnessRpcApprovalService implements ApprovalService<unknown> {
	private readonly pending = new Map<string, (decision: ApprovalDecision) => void>();
	private sink: ApprovalSink | undefined;
	private closed = false;

	bind(sink: ApprovalSink): () => void {
		if (this.closed) throw new Error("Harness RPC approval service is closed");
		if (this.sink) throw new Error("Harness RPC approval service is already bound");
		this.sink = sink;
		return () => {
			if (this.sink === sink) this.sink = undefined;
		};
	}

	async requestApproval(request: ToolRequest<unknown>, signal?: AbortSignal): Promise<ApprovalDecision> {
		if (this.closed) return { decision: "deny", reason: "Harness RPC approval service is closed" };
		if (!this.sink) return { decision: "deny", reason: "Harness RPC approval client is not connected" };
		if (this.pending.has(request.id)) {
			return { decision: "deny", reason: `Duplicate pending approval request: ${request.id}` };
		}
		if (signal?.aborted) return { decision: "deny", reason: "Tool approval was aborted" };

		return new Promise<ApprovalDecision>((resolve) => {
			const finish = (decision: ApprovalDecision) => {
				signal?.removeEventListener("abort", onAbort);
				this.pending.delete(request.id);
				resolve(decision);
			};
			const onAbort = () => finish({ decision: "deny", reason: "Tool approval was aborted" });
			this.pending.set(request.id, finish);
			signal?.addEventListener("abort", onAbort, { once: true });
			void Promise.resolve(this.sink?.({ type: "approval_request", request: structuredClone(request) })).catch(
				(error) => finish({ decision: "deny", reason: error instanceof Error ? error.message : String(error) }),
			);
		});
	}

	respond(requestId: string, decision: ApprovalDecision): void {
		const finish = this.pending.get(requestId);
		if (!finish) throw new Error(`No pending approval request: ${requestId}`);
		finish(decision);
	}

	close(reason = "Harness RPC session closed"): void {
		if (this.closed) return;
		this.closed = true;
		this.sink = undefined;
		for (const finish of [...this.pending.values()]) finish({ decision: "deny", reason });
	}
}
