import { randomUUID } from "node:crypto";
import { type ExtensionUIContext, getNoOpExtensionUIContext } from "../../core/extensions/index.ts";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "./rpc-types.ts";

export type HarnessRpcExtensionUIEventSink = (event: RpcExtensionUIRequest) => void | Promise<void>;

type PendingRequest = {
	resolve(response: RpcExtensionUIResponse): void;
	cancel(): void;
};

type ExtensionUIRequestPayload<TRequest extends RpcExtensionUIRequest = RpcExtensionUIRequest> =
	TRequest extends RpcExtensionUIRequest ? Omit<TRequest, "type" | "id"> : never;

/** RPC-backed Extension UI with fail-closed dialog lifetime management. */
export class HarnessRpcExtensionUIService {
	readonly context: ExtensionUIContext;
	private sink?: HarnessRpcExtensionUIEventSink;
	private readonly pending = new Map<string, PendingRequest>();

	constructor() {
		const fallback = getNoOpExtensionUIContext();
		this.context = {
			...fallback,
			select: (title, options, dialogOptions) =>
				this.request(
					{ method: "select", title, options, timeout: dialogOptions?.timeout },
					dialogOptions,
					undefined,
					(response) => ("value" in response ? response.value : undefined),
				),
			confirm: (title, message, dialogOptions) =>
				this.request(
					{ method: "confirm", title, message, timeout: dialogOptions?.timeout },
					dialogOptions,
					false,
					(response) => ("confirmed" in response ? response.confirmed : false),
				),
			input: (title, placeholder, dialogOptions) =>
				this.request(
					{ method: "input", title, placeholder, timeout: dialogOptions?.timeout },
					dialogOptions,
					undefined,
					(response) => ("value" in response ? response.value : undefined),
				),
			editor: (title, prefill) =>
				this.request({ method: "editor", title, prefill }, undefined, undefined, (response) =>
					"value" in response ? response.value : undefined,
				),
			notify: (message, type) => this.emit({ method: "notify", message, notifyType: type }),
			setStatus: (key, text) => this.emit({ method: "setStatus", statusKey: key, statusText: text }),
			setWidget: (key, content, options) => {
				if (content === undefined || Array.isArray(content)) {
					this.emit({
						method: "setWidget",
						widgetKey: key,
						widgetLines: content,
						widgetPlacement: options?.placement,
					});
				}
			},
			setTitle: (title) => this.emit({ method: "setTitle", title }),
			pasteToEditor: (text) => this.emit({ method: "set_editor_text", text }),
			setEditorText: (text) => this.emit({ method: "set_editor_text", text }),
		};
	}

	bind(sink: HarnessRpcExtensionUIEventSink): () => void {
		this.sink = sink;
		return () => {
			if (this.sink === sink) this.sink = undefined;
			this.cancelPending();
		};
	}

	respond(response: RpcExtensionUIResponse): boolean {
		const pending = this.pending.get(response.id);
		if (!pending) return false;
		pending.resolve(response);
		return true;
	}

	cancelPending(): void {
		for (const pending of [...this.pending.values()]) pending.cancel();
	}

	close(): void {
		this.cancelPending();
		this.sink = undefined;
	}

	private request<T>(
		request: ExtensionUIRequestPayload,
		options: { signal?: AbortSignal; timeout?: number } | undefined,
		defaultValue: T,
		parse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (options?.signal?.aborted || !this.sink) return Promise.resolve(defaultValue);
		const id = randomUUID();
		return new Promise<T>((resolve) => {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const finish = (value: T) => {
				if (!this.pending.delete(id)) return;
				if (timeout) clearTimeout(timeout);
				options?.signal?.removeEventListener("abort", cancel);
				resolve(value);
			};
			const cancel = () => finish(defaultValue);
			this.pending.set(id, { resolve: (response) => finish(parse(response)), cancel });
			options?.signal?.addEventListener("abort", cancel, { once: true });
			if (options?.timeout !== undefined) timeout = setTimeout(cancel, options.timeout);
			this.emit(request, id);
		});
	}

	private emit(event: ExtensionUIRequestPayload, id = randomUUID()): void {
		if (!this.sink) return;
		const emitted = this.sink({
			...event,
			type: "extension_ui_request",
			id,
		} as RpcExtensionUIRequest);
		void Promise.resolve(emitted);
	}
}
