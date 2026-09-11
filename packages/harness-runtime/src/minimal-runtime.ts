import {
	type AgentTool,
	type AgentToolResult,
	InMemorySessionRepo,
	type Session,
	type StreamFn,
	type TelemetryContext,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { type ModelSelection, PiModelsProvider } from "./models-provider.ts";
import {
	type DriverCompactionService,
	type DriverMessageCommitMiddleware,
	type DriverRunPreparationMiddleware,
	type DriverToolLifecycleMiddleware,
	PiAgentDriver,
	type ToolReconciliationConfig,
} from "./pi-agent-driver.ts";
import { type HarnessPlugin, PluginHost, type PluginSpec } from "./plugin-host.ts";
import { type Bundle, composeProfile, type Profile, type ResolvedProfile } from "./profile.ts";
import { PromptCatalog, type PromptContributor } from "./prompt.ts";
import { createResolvedManifest, type PluginContract, type ResolvedManifestV1 } from "./resolved-manifest.ts";
import { createServiceToken } from "./services.ts";
import { ToolCatalog, type ToolCatalogRegistration } from "./tool-catalog.ts";
import type { ApprovalService, ToolPipeline } from "./tool-pipeline.ts";

export const SESSION_SERVICE = createServiceToken<Session>("pi-ds.session");
export const TOOLS_SERVICE = createServiceToken<ToolCatalog>("pi-ds.tools");
export const PROMPT_SERVICE = createServiceToken<PromptCatalog>("pi-ds.prompt");
export const MODELS_SERVICE = createServiceToken<RuntimeModelService>("pi-ds.models");
export const AGENT_DRIVER_SERVICE = createServiceToken<PiAgentDriver>("pi-ds.agent-driver");
export const COMPACTION_SERVICE = createServiceToken<DriverCompactionService>("pi-ds.compaction");
export const APPROVAL_SERVICE = createServiceToken<ApprovalService<unknown>>("pi-ds.coding.approval");
export const TELEMETRY_SERVICE = createServiceToken<TelemetryContext>("pi-ds.telemetry");
export const MESSAGE_COMMIT_MIDDLEWARE_SERVICE = createServiceToken<DriverMessageCommitMiddleware>(
	"pi-ds.message-commit-middleware",
);
export const RUN_PREPARATION_MIDDLEWARE_SERVICE = createServiceToken<DriverRunPreparationMiddleware>(
	"pi-ds.run-preparation-middleware",
);
export const TOOL_LIFECYCLE_MIDDLEWARE_SERVICE = createServiceToken<DriverToolLifecycleMiddleware>(
	"pi-ds.tool-lifecycle-middleware",
);

export const MINIMAL_BUNDLE: Bundle = {
	id: "minimal",
	plugins: [
		{ id: "session-memory", plugin: "session-memory", scope: "agent" },
		{ id: "tools", plugin: "tools-static", scope: "agent" },
		{ id: "prompt", plugin: "prompt-contributors", scope: "agent" },
		{ id: "models", plugin: "pi-models-provider", scope: "agent" },
		{ id: "driver", plugin: "pi-agent-driver", scope: "agent" },
	],
};

export const MINIMAL_PROFILE: Profile = { id: "minimal", bundles: ["minimal"] };

export const MINIMAL_PLUGIN_CONTRACTS: ReadonlyMap<string, PluginContract> = new Map([
	["session-memory", { plugin: "session-memory", provides: [SESSION_SERVICE.id] }],
	["tools-static", { plugin: "tools-static", provides: [TOOLS_SERVICE.id] }],
	["prompt-contributors", { plugin: "prompt-contributors", provides: [PROMPT_SERVICE.id] }],
	["pi-models-provider", { plugin: "pi-models-provider", provides: [MODELS_SERVICE.id] }],
	[
		"pi-agent-driver",
		{
			plugin: "pi-agent-driver",
			provides: [AGENT_DRIVER_SERVICE.id],
			requires: [SESSION_SERVICE.id, TOOLS_SERVICE.id, PROMPT_SERVICE.id, MODELS_SERVICE.id],
		},
	],
]);

export function resolveMinimalProfile(): ResolvedProfile {
	return composeProfile(MINIMAL_PROFILE, new Map([[MINIMAL_BUNDLE.id, MINIMAL_BUNDLE]]));
}

export function resolveMinimalManifest(): ResolvedManifestV1 {
	return createResolvedManifest(resolveMinimalProfile(), MINIMAL_PLUGIN_CONTRACTS);
}

export interface MinimalRuntimeOptions {
	streamFn?: StreamFn;
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	models?: Models;
	modelSelection?: ModelSelection;
	tools?: AgentTool[];
	toolReplay?: Readonly<Record<string, "never" | "safe">>;
	toolPolicies?: Readonly<
		Record<string, { version: string; pipeline: ToolPipeline<unknown, AgentToolResult<unknown>> }>
	>;
	toolReconciliation?: ToolReconciliationConfig;
	messageCommitMiddleware?: DriverMessageCommitMiddleware;
	runPreparationMiddleware?: DriverRunPreparationMiddleware;
	toolLifecycleMiddleware?: DriverToolLifecycleMiddleware;
	systemPrompt?: string;
	promptContributors?: readonly PromptContributor[];
	/** Use a pre-opened durable session, such as a JsonlSessionRepo session. */
	session?: Session;
	sessionRepo?: InMemorySessionRepo;
	sessionId?: string;
}

export interface MinimalRuntime {
	profile: ResolvedProfile;
	session: Session;
	driver: PiAgentDriver;
	toolCatalog: ToolCatalog;
	dispose(): Promise<void>;
}

export async function createMinimalRuntime(options: MinimalRuntimeOptions): Promise<MinimalRuntime> {
	return createComposedRuntime(options, { profile: resolveMinimalProfile(), sessionPluginId: "session-memory" });
}

export interface RuntimeComposition {
	profile: ResolvedProfile;
	sessionPluginId: string;
	plugins?: readonly PluginSpec[];
}

export async function createComposedRuntime(
	options: MinimalRuntimeOptions,
	composition: RuntimeComposition,
): Promise<MinimalRuntime> {
	if (options.session && (options.sessionRepo || options.sessionId)) {
		throw new Error("session cannot be combined with sessionRepo or sessionId");
	}
	if (options.streamFn && options.models) throw new Error("streamFn cannot be combined with models");
	if (!options.streamFn && !options.models) throw new Error("Either streamFn or models must be provided");
	if (options.models && !options.modelSelection) throw new Error("modelSelection is required with models");
	if (options.modelSelection && !options.models) throw new Error("modelSelection requires models");
	if (options.model && options.models) throw new Error("model cannot be combined with models; use modelSelection");
	const host = new PluginHost();
	const sessionConfig: SessionPluginConfig = options.session
		? { session: options.session }
		: { repo: options.sessionRepo ?? new InMemorySessionRepo(), sessionId: options.sessionId };
	const specs: PluginSpec[] = [
		{
			plugin: createSessionPlugin(composition.sessionPluginId),
			config: sessionConfig,
		},
		{
			plugin: toolsPlugin,
			config: (options.tools ?? []).map(
				(tool): ToolCatalogRegistration => ({
					tool,
					replay: options.toolReplay?.[tool.name],
					policyVersion: options.toolPolicies?.[tool.name]?.version,
					pipeline: options.toolPolicies?.[tool.name]?.pipeline,
				}),
			),
		},
		{
			plugin: promptPlugin,
			config: {
				basePrompt: options.systemPrompt ?? "You are a helpful assistant.",
				contributors: options.promptContributors ?? [],
			},
		},
		{
			plugin: modelsPlugin,
			config: options.models
				? { kind: "pi-models", models: options.models, selection: options.modelSelection! }
				: { kind: "direct", streamFn: options.streamFn!, model: options.model },
		},
		...(composition.plugins ?? []),
		{
			plugin: driverPlugin,
			config: {
				thinkingLevel: options.thinkingLevel,
				toolReplay: options.toolReplay,
				toolReconciliation: options.toolReconciliation,
				messageCommitMiddleware: options.messageCommitMiddleware,
				runPreparationMiddleware: options.runPreparationMiddleware,
				toolLifecycleMiddleware: options.toolLifecycleMiddleware,
			},
		},
	];
	assertRuntimeComposition(composition.profile, specs);
	await host.start(specs);
	return {
		profile: structuredClone(composition.profile),
		session: host.require(SESSION_SERVICE),
		driver: host.require(AGENT_DRIVER_SERVICE),
		toolCatalog: host.require(TOOLS_SERVICE),
		dispose: () => host.stop(),
	};
}

function assertRuntimeComposition(profile: ResolvedProfile, specs: readonly PluginSpec[]): void {
	const declared = profile.plugins
		.filter((spec) => spec.enabled ?? true)
		.map((spec) => spec.plugin)
		.sort();
	const activated = specs.map((spec) => spec.plugin.manifest.id).sort();
	if (JSON.stringify(declared) !== JSON.stringify(activated)) {
		throw new Error(
			`Runtime plugins do not match resolved Profile ${profile.id}: declared [${declared.join(", ")}], activated [${activated.join(", ")}]`,
		);
	}
}

type SessionPluginConfig = { session: Session } | { repo: InMemorySessionRepo; sessionId?: string };

function createSessionPlugin(id: string): HarnessPlugin<SessionPluginConfig> {
	return {
		manifest: { id, version: "0.1.0", provides: [SESSION_SERVICE] },
		async activate(context, config) {
			if ("session" in config) {
				context.provide(SESSION_SERVICE, config.session);
				return;
			}
			const existing = config.sessionId
				? (await config.repo.list()).find((metadata) => metadata.id === config.sessionId)
				: undefined;
			const session = existing
				? await config.repo.open(existing)
				: await config.repo.create({ id: config.sessionId });
			context.provide(SESSION_SERVICE, session);
		},
	};
}

const toolsPlugin: HarnessPlugin<ToolCatalogRegistration[]> = {
	manifest: { id: "tools-static", version: "0.1.0", provides: [TOOLS_SERVICE] },
	activate(context, registrations) {
		const catalog = new ToolCatalog();
		for (const registration of registrations) catalog.register(registration);
		context.provide(TOOLS_SERVICE, catalog);
	},
};

const promptPlugin: HarnessPlugin<{ basePrompt: string; contributors: readonly PromptContributor[] }> = {
	manifest: { id: "prompt-contributors", version: "0.1.0", provides: [PROMPT_SERVICE] },
	activate(context, config) {
		const catalog = new PromptCatalog(config.basePrompt);
		for (const contributor of config.contributors) catalog.register(contributor);
		context.provide(PROMPT_SERVICE, catalog);
	},
};

interface RuntimeModelService {
	streamFn: StreamFn;
	model?: Model<Api>;
}

type ModelsPluginConfig =
	| { kind: "direct"; streamFn: StreamFn; model?: Model<Api> }
	| { kind: "pi-models"; models: Models; selection: ModelSelection };

const modelsPlugin: HarnessPlugin<ModelsPluginConfig> = {
	manifest: { id: "pi-models-provider", version: "0.1.0", provides: [MODELS_SERVICE] },
	activate(context, config) {
		if (config.kind === "direct") {
			context.provide(MODELS_SERVICE, { streamFn: config.streamFn, model: config.model });
			return;
		}
		const provider = new PiModelsProvider(config.models);
		context.provide(MODELS_SERVICE, { streamFn: provider.stream, model: provider.resolve(config.selection) });
	},
};

const driverPlugin: HarnessPlugin<{
	toolReplay?: Readonly<Record<string, "never" | "safe">>;
	toolReconciliation?: ToolReconciliationConfig;
	messageCommitMiddleware?: DriverMessageCommitMiddleware;
	runPreparationMiddleware?: DriverRunPreparationMiddleware;
	toolLifecycleMiddleware?: DriverToolLifecycleMiddleware;
	thinkingLevel?: ThinkingLevel;
}> = {
	manifest: {
		id: "pi-agent-driver",
		version: "0.1.0",
		provides: [AGENT_DRIVER_SERVICE],
		requires: [SESSION_SERVICE, TOOLS_SERVICE, PROMPT_SERVICE, MODELS_SERVICE],
		optional: [
			COMPACTION_SERVICE,
			TELEMETRY_SERVICE,
			MESSAGE_COMMIT_MIDDLEWARE_SERVICE,
			RUN_PREPARATION_MIDDLEWARE_SERVICE,
			TOOL_LIFECYCLE_MIDDLEWARE_SERVICE,
		],
	},
	async activate(context, config) {
		const prompt = await context.require(PROMPT_SERVICE).render();
		const models = context.require(MODELS_SERVICE);
		const driver = await PiAgentDriver.create({
			session: context.require(SESSION_SERVICE),
			streamFn: models.streamFn,
			model: models.model,
			thinkingLevel: config.thinkingLevel,
			tools: context.require(TOOLS_SERVICE).list(),
			systemPrompt: prompt.text,
			toolReplay: {
				...context.require(TOOLS_SERVICE).replayPolicies(),
				...config.toolReplay,
			},
			toolPolicyVersions: context.require(TOOLS_SERVICE).policyVersions(),
			toolReconciliation: config.toolReconciliation,
			compaction: context.get(COMPACTION_SERVICE),
			telemetry: context.get(TELEMETRY_SERVICE),
			messageCommitMiddleware: config.messageCommitMiddleware ?? context.get(MESSAGE_COMMIT_MIDDLEWARE_SERVICE),
			runPreparationMiddleware: config.runPreparationMiddleware ?? context.get(RUN_PREPARATION_MIDDLEWARE_SERVICE),
			toolLifecycleMiddleware: config.toolLifecycleMiddleware ?? context.get(TOOL_LIFECYCLE_MIDDLEWARE_SERVICE),
		});
		context.provide(AGENT_DRIVER_SERVICE, driver);
		return driver;
	},
};
