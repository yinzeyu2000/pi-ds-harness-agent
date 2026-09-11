import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model, Models, SimpleStreamOptions } from "@earendil-works/pi-ai";

export interface ModelSelection {
	provider: string;
	id: string;
}

export class HarnessModelNotFoundError extends Error {
	readonly selection: ModelSelection;

	constructor(selection: ModelSelection) {
		super(`Model is not available: ${selection.provider}/${selection.id}`);
		this.name = "HarnessModelNotFoundError";
		this.selection = structuredClone(selection);
	}
}

export class PiModelsProvider {
	private readonly models: Models;

	constructor(models: Models) {
		this.models = models;
	}

	resolve(selection: ModelSelection): Model<Api> {
		const model = this.models.getModel(selection.provider, selection.id);
		if (!model) throw new HarnessModelNotFoundError(selection);
		return model;
	}

	stream: StreamFn = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
		this.models.streamSimple(model, context, options);
}
