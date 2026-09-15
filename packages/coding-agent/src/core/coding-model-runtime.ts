import {
	type CompactionSettings,
	compact,
	generateBranchSummary,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { DriverCompactionService } from "@pi-ds/harness-runtime";
import { type CodingRuntime, type CreateCodingRuntimeOptions, createCodingRuntime } from "./coding-runtime.ts";

export interface CreateModelCompactionServiceOptions {
	models: Models;
	model: Model<Api>;
	settings: CompactionSettings;
	thinkingLevel?: ThinkingLevel;
}

export function createModelCompactionService(options: CreateModelCompactionServiceOptions): DriverCompactionService {
	return {
		settings: structuredClone(options.settings),
		async execute(preparation, request) {
			const result = await compact(
				preparation,
				options.models,
				request.model ?? options.model,
				request.customInstructions,
				request.signal,
				request.thinkingLevel ?? options.thinkingLevel,
			);
			if (!result.ok) throw result.error;
			return result.value;
		},
		async summarizeBranch(entries, request) {
			const result = await generateBranchSummary(entries, {
				models: options.models,
				model: request.model,
				signal: request.signal,
				customInstructions: request.customInstructions,
			});
			if (!result.ok) throw result.error;
			return result.value;
		},
	};
}

export interface CreateModelBackedCodingRuntimeOptions
	extends Omit<CreateCodingRuntimeOptions, "streamFn" | "models" | "model" | "modelSelection" | "compaction"> {
	models: Models;
	model: Model<Api>;
	compactionSettings: CompactionSettings;
	thinkingLevel?: CreateModelCompactionServiceOptions["thinkingLevel"];
}

export function createModelBackedCodingRuntime(options: CreateModelBackedCodingRuntimeOptions): Promise<CodingRuntime> {
	const { models, model, compactionSettings, thinkingLevel, ...runtimeOptions } = options;
	return createCodingRuntime({
		...runtimeOptions,
		models,
		thinkingLevel,
		modelSelection: { provider: model.provider, id: model.id },
		compaction: createModelCompactionService({
			models,
			model,
			settings: compactionSettings,
			thinkingLevel,
		}),
	});
}
