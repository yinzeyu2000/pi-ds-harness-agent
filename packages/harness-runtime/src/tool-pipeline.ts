import { type Guard, runMonotonicGuards } from "./events.ts";

export interface ToolRequest<TArgs> {
	id: string;
	name: string;
	args: TArgs;
}

export interface ToolFailure {
	code: string;
	message: string;
}

export interface ToolResult<TValue> {
	value?: TValue;
	isError: boolean;
	error?: ToolFailure;
}

export type ApprovalDecision = { decision: "allow" } | { decision: "deny"; reason: string };

export interface ApprovalService<TArgs> {
	requestApproval(request: ToolRequest<TArgs>, signal?: AbortSignal): ApprovalDecision | Promise<ApprovalDecision>;
}

export class HeadlessApprovalService<TArgs> implements ApprovalService<TArgs> {
	requestApproval(): ApprovalDecision {
		return { decision: "deny", reason: "Approval is required but no interactive approval service is available" };
	}
}

export interface ToolApproval<TArgs> {
	required: boolean | ((request: ToolRequest<TArgs>) => boolean | Promise<boolean>);
	service?: ApprovalService<TArgs>;
}

export interface ToolPipeline<TArgs, TValue> {
	pre?: ReadonlyArray<(request: ToolRequest<TArgs>) => ToolRequest<TArgs> | Promise<ToolRequest<TArgs>>>;
	guards?: readonly Guard<ToolRequest<TArgs>>[];
	approval?: ToolApproval<TArgs>;
	around?: ReadonlyArray<
		(request: ToolRequest<TArgs>, next: () => Promise<ToolResult<TValue>>) => Promise<ToolResult<TValue>>
	>;
	post?: ReadonlyArray<
		(request: ToolRequest<TArgs>, result: ToolResult<TValue>) => ToolResult<TValue> | Promise<ToolResult<TValue>>
	>;
	result?: ReadonlyArray<
		(request: ToolRequest<TArgs>, result: ToolResult<TValue>) => ToolResult<TValue> | Promise<ToolResult<TValue>>
	>;
}

export async function executeToolPipeline<TArgs, TValue>(
	request: ToolRequest<TArgs>,
	body: (request: ToolRequest<TArgs>) => Promise<TValue>,
	pipeline: ToolPipeline<TArgs, TValue> = {},
	signal?: AbortSignal,
): Promise<ToolResult<TValue>> {
	let effectiveRequest = cloneRequest(request);
	for (const pre of pipeline.pre ?? []) {
		if (signal?.aborted) {
			return finishResult(effectiveRequest, failure("aborted", "Tool execution was aborted"), pipeline.result);
		}
		try {
			effectiveRequest = cloneRequest(await pre(effectiveRequest));
		} catch (error) {
			return finishResult(effectiveRequest, failure("pre_error", errorMessage(error)), pipeline.result);
		}
	}
	const frozenRequest = freezeRequest(effectiveRequest);

	if (signal?.aborted)
		return finishResult(frozenRequest, failure("aborted", "Tool execution was aborted"), pipeline.result);
	try {
		const guard = await runMonotonicGuards(frozenRequest, pipeline.guards ?? []);
		if (guard.decision === "deny") {
			return finishResult(frozenRequest, failure("denied", guard.reason), pipeline.result);
		}
	} catch (error) {
		return finishResult(frozenRequest, failure("guard_error", errorMessage(error)), pipeline.result);
	}

	if (pipeline.approval) {
		let required: boolean;
		try {
			required =
				typeof pipeline.approval.required === "function"
					? await pipeline.approval.required(frozenRequest)
					: pipeline.approval.required;
		} catch (error) {
			return finishResult(frozenRequest, failure("approval_error", errorMessage(error)), pipeline.result);
		}
		if (required) {
			if (signal?.aborted) {
				return finishResult(frozenRequest, failure("aborted", "Tool execution was aborted"), pipeline.result);
			}
			try {
				const service = pipeline.approval.service ?? new HeadlessApprovalService<TArgs>();
				const decision = await service.requestApproval(frozenRequest, signal);
				if (decision.decision === "deny") {
					return finishResult(frozenRequest, failure("approval_denied", decision.reason), pipeline.result);
				}
			} catch (error) {
				return finishResult(frozenRequest, failure("approval_error", errorMessage(error)), pipeline.result);
			}
		}
	}

	let invoke = async (): Promise<ToolResult<TValue>> => {
		if (signal?.aborted) return failure("aborted", "Tool execution was aborted");
		try {
			return { value: await body(frozenRequest), isError: false };
		} catch (error) {
			return failure("tool_error", errorMessage(error));
		}
	};
	for (const around of [...(pipeline.around ?? [])].reverse()) {
		const next = invoke;
		invoke = async () => {
			let called = false;
			try {
				return await around(frozenRequest, async () => {
					if (called) throw new Error("Tool middleware next() may only be called once");
					called = true;
					return next();
				});
			} catch (error) {
				return failure("middleware_error", errorMessage(error));
			}
		};
	}

	let result = await invoke();
	for (const post of pipeline.post ?? []) {
		try {
			result = await post(frozenRequest, cloneResult(result));
		} catch (error) {
			result = failure("post_error", errorMessage(error));
			break;
		}
	}
	return finishResult(frozenRequest, result, pipeline.result);
}

async function finishResult<TArgs, TValue>(
	request: ToolRequest<TArgs>,
	initial: ToolResult<TValue>,
	handlers: ToolPipeline<TArgs, TValue>["result"],
): Promise<ToolResult<TValue>> {
	let result = initial;
	for (const handler of handlers ?? []) {
		try {
			result = await handler(request, cloneResult(result));
		} catch (error) {
			result = failure("result_error", errorMessage(error));
			break;
		}
	}
	return cloneResult(result);
}

function cloneRequest<TArgs>(request: ToolRequest<TArgs>): ToolRequest<TArgs> {
	return structuredClone(request);
}

function freezeRequest<TArgs>(request: ToolRequest<TArgs>): ToolRequest<TArgs> {
	return Object.freeze(cloneRequest(request));
}

function cloneResult<TValue>(result: ToolResult<TValue>): ToolResult<TValue> {
	return structuredClone(result);
}

function failure<TValue>(code: string, message: string): ToolResult<TValue> {
	return { isError: true, error: { code, message } };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
