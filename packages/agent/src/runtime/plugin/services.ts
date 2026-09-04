import type { AgentDriver } from "../types/agent-driver.ts";
import type { ExecutionBroker } from "../types/execution-broker.ts";
import type { ThreadJournalStore } from "../types/journal.ts";
import type { ModelGateway } from "../types/model-gateway.ts";
import { createServiceToken, type ServiceToken } from "./tokens.ts";

export interface ToolCatalog {
	registerTool(tool: any): void;
	getTools(): readonly any[];
}

export interface PromptContributor {
	name: string;
	contribute(): Promise<string | undefined> | string | undefined;
}

export interface PromptCatalog {
	registerContributor(contributor: PromptContributor): void;
	getContributors(): readonly PromptContributor[];
}

export const MODELS_SERVICE: ServiceToken<ModelGateway> = createServiceToken<ModelGateway>("pi.models");
export const TOOLS_SERVICE: ServiceToken<ToolCatalog> = createServiceToken<ToolCatalog>("pi.tools");
export const PROMPT_SERVICE: ServiceToken<PromptCatalog> = createServiceToken<PromptCatalog>("pi.prompt");
export const SESSION_SERVICE: ServiceToken<ThreadJournalStore> = createServiceToken<ThreadJournalStore>("pi.session");
export const BROKER_SERVICE: ServiceToken<ExecutionBroker> = createServiceToken<ExecutionBroker>("pi.broker");
export const DRIVER_SERVICE: ServiceToken<AgentDriver> = createServiceToken<AgentDriver>("pi.driver");
