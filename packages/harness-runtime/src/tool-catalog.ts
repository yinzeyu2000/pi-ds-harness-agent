import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { executeToolPipeline, type ToolFailure, type ToolPipeline } from "./tool-pipeline.ts";

export interface ToolCatalogRegistration {
	tool: AgentTool;
	replay?: "never" | "safe";
	policyVersion?: string;
	pipeline?: ToolPipeline<unknown, AgentToolResult<unknown>>;
}

interface StoredToolRegistration {
	tool: AgentTool;
	replay: "never" | "safe";
	policyVersion?: string;
}

export class ToolCatalogConflictError extends Error {
	readonly toolName: string;

	constructor(toolName: string) {
		super(`Tool is already registered in this catalog: ${toolName}`);
		this.name = "ToolCatalogConflictError";
		this.toolName = toolName;
	}
}

export class ToolPipelineExecutionError extends Error {
	readonly failure: ToolFailure;

	constructor(failure: ToolFailure) {
		super(failure.message);
		this.name = "ToolPipelineExecutionError";
		this.failure = structuredClone(failure);
	}
}

export class ToolCatalog {
	private readonly registrations = new Map<string, StoredToolRegistration>();

	register(registration: ToolCatalogRegistration): () => void {
		const name = registration.tool.name;
		if (this.registrations.has(name)) throw new ToolCatalogConflictError(name);
		if (registration.pipeline && !registration.policyVersion) {
			throw new Error(`Tool pipeline ${name} must declare a policyVersion for recovery checks`);
		}
		const stored: StoredToolRegistration = {
			tool: registration.pipeline ? wrapTool(registration.tool, registration.pipeline) : registration.tool,
			replay: registration.replay ?? "never",
			...(registration.policyVersion ? { policyVersion: registration.policyVersion } : {}),
		};
		this.registrations.set(name, stored);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			if (this.registrations.get(name) === stored) this.registrations.delete(name);
		};
	}

	get(name: string): AgentTool | undefined {
		return this.registrations.get(name)?.tool;
	}

	list(): AgentTool[] {
		return [...this.registrations.values()].map(({ tool }) => tool);
	}

	replayPolicies(): Readonly<Record<string, "never" | "safe">> {
		return Object.fromEntries(
			[...this.registrations.entries()].map(([name, registration]) => [name, registration.replay]),
		);
	}

	policyVersions(): Readonly<Record<string, string>> {
		return Object.fromEntries(
			[...this.registrations.entries()].flatMap(([name, registration]) =>
				registration.policyVersion ? [[name, registration.policyVersion]] : [],
			),
		);
	}

	get size(): number {
		return this.registrations.size;
	}
}

function wrapTool(tool: AgentTool, pipeline: ToolPipeline<unknown, AgentToolResult<unknown>>): AgentTool {
	return {
		...tool,
		async execute(toolCallId, params, signal, onUpdate) {
			const result = await executeToolPipeline<unknown, AgentToolResult<unknown>>(
				{ id: toolCallId, name: tool.name, args: params },
				(request) => tool.execute(toolCallId, request.args as never, signal, onUpdate),
				pipeline,
				signal,
			);
			if (result.isError) {
				throw new ToolPipelineExecutionError(
					result.error ?? { code: "invalid_result", message: "Tool pipeline returned an invalid error result" },
				);
			}
			if (result.value === undefined) {
				throw new ToolPipelineExecutionError({
					code: "invalid_result",
					message: "Tool pipeline returned no value",
				});
			}
			return result.value;
		},
	};
}
