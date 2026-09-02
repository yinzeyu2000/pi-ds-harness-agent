import { type Guard, runMonotonicGuards } from "./events.ts";

export interface ToolRequest<TArgs> {
	id: string;
	name: string;
	args: TArgs;
}

export interface ToolResult<TValue> {
	value?: TValue;
	isError: boolean;
	error?: { code: string; message: string };
}

export interface ToolPipeline<TArgs, TValue> {
	guards?: readonly Guard<ToolRequest<TArgs>>[];
	around?: ReadonlyArray<
		(request: ToolRequest<TArgs>, next: () => Promise<ToolResult<TValue>>) => Promise<ToolResult<TValue>>
	>;
	post?: ReadonlyArray<
		(request: ToolRequest<TArgs>, result: ToolResult<TValue>) => ToolResult<TValue> | Promise<ToolResult<TValue>>
	>;
}

export async function executeToolPipeline<TArgs, TValue>(
	request: ToolRequest<TArgs>,
	body: (request: ToolRequest<TArgs>) => Promise<TValue>,
	pipeline: ToolPipeline<TArgs, TValue> = {},
): Promise<ToolResult<TValue>> {
	const frozenRequest = Object.freeze(structuredClone(request));
	const guard = await runMonotonicGuards(frozenRequest, pipeline.guards ?? []);
	if (guard.decision === "deny") {
		return { isError: true, error: { code: "denied", message: guard.reason } };
	}
	let invoke = async (): Promise<ToolResult<TValue>> => {
		try {
			return { value: await body(frozenRequest), isError: false };
		} catch (error) {
			return {
				isError: true,
				error: { code: "tool_error", message: error instanceof Error ? error.message : String(error) },
			};
		}
	};
	for (const around of [...(pipeline.around ?? [])].reverse()) {
		const next = invoke;
		invoke = () => around(frozenRequest, next);
	}
	let result = await invoke();
	for (const post of pipeline.post ?? []) result = await post(frozenRequest, result);
	return structuredClone(result);
}
