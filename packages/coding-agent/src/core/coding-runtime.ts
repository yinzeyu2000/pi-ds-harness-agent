import {
	type AgentTool,
	type AgentToolResult,
	type JsonlSessionMetadata,
	JsonlSessionRepo,
	NOOP_TELEMETRY_CONTEXT,
	type Session,
	type TelemetryContext,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
	APPROVAL_SERVICE,
	type ApprovalService,
	COMPACTION_SERVICE,
	createComposedRuntime,
	type DriverCompactionService,
	type HarnessPlugin,
	HeadlessApprovalService,
	MESSAGE_COMMIT_MIDDLEWARE_SERVICE,
	type MinimalRuntime,
	type MinimalRuntimeOptions,
	PROMPT_SERVICE,
	RUN_PREPARATION_MIDDLEWARE_SERVICE,
	resolveCodingProfile,
	TELEMETRY_SERVICE,
	TOOL_LIFECYCLE_MIDDLEWARE_SERVICE,
	TOOLS_SERVICE,
	type ToolCatalogRegistration,
	type ToolPipeline,
} from "@pi-ds/harness-runtime";
import { getAgentDir } from "../config.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import {
	bindLegacyExtensionRuntimeActions,
	type CodingRuntimeCommand,
	createLegacyExtensionCommands,
	createLegacyExtensionSetPlugin,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionError,
	LEGACY_EXTENSIONS_SERVICE,
	type LegacyExtensionSetContribution,
	type LegacyExtensionSpec,
	prepareLegacyExtensionRun,
	type RegisteredTool,
	runLegacyExtensionAfterTool,
	runLegacyExtensionBeforeTool,
	subscribeLegacyExtensionEvents,
	transformLegacyExtensionMessageEnd,
} from "./extensions/index.ts";
import { loadPromptTemplates, type PromptTemplate } from "./prompt-templates.ts";
import { formatSkillsForPrompt, loadSkills, type Skill } from "./skills.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.ts";
import { bashToolSystemPromptContribution } from "./tools/bash.ts";
import { editToolSystemPromptContribution } from "./tools/edit.ts";
import { findToolSystemPromptContribution } from "./tools/find.ts";
import { grepToolSystemPromptContribution } from "./tools/grep.ts";
import { createTool, type ToolName, type ToolsOptions } from "./tools/index.ts";
import { lsToolSystemPromptContribution } from "./tools/ls.ts";
import { powershellToolSystemPromptContribution } from "./tools/powershell.ts";
import { readToolSystemPromptContribution } from "./tools/read.ts";
import { wrapToolDefinition } from "./tools/tool-definition-wrapper.ts";
import { writeToolSystemPromptContribution } from "./tools/write.ts";

const DEFAULT_CODING_TOOL_NAMES: readonly ToolName[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const SAFE_REPLAY_TOOLS = new Set<ToolName>(["read", "grep", "find", "ls"]);
const APPROVAL_REQUIRED_TOOLS = new Set<ToolName>(["bash", "powershell", "edit", "write"]);
const DEFAULT_APPROVAL_POLICY_VERSION = "coding-approval/v1";
const LEGACY_EXTENSION_POLICY_VERSION = "legacy-extension-approval/v1";

const TOOL_PROMPTS: Readonly<Record<ToolName, { snippet: string; guidelines: readonly string[] }>> = {
	read: readToolSystemPromptContribution,
	bash: bashToolSystemPromptContribution,
	powershell: powershellToolSystemPromptContribution,
	edit: editToolSystemPromptContribution,
	write: writeToolSystemPromptContribution,
	grep: grepToolSystemPromptContribution,
	find: findToolSystemPromptContribution,
	ls: lsToolSystemPromptContribution,
};

export interface CreateCodingRuntimeOptions
	extends Omit<MinimalRuntimeOptions, "session" | "sessionRepo" | "sessionId" | "tools" | "systemPrompt"> {
	cwd: string;
	sessionsRoot: string;
	sessionId?: string;
	parentSessionId?: string;
	tools?: readonly AgentTool[];
	toolNames?: readonly ToolName[];
	toolOptions?: ToolsOptions;
	skills?: readonly Skill[];
	skillPaths?: readonly string[];
	includeDefaultSkills?: boolean;
	promptTemplates?: readonly PromptTemplate[];
	promptTemplatePaths?: readonly string[];
	includeDefaultPromptTemplates?: boolean;
	projectTrusted?: boolean;
	agentDir?: string;
	compaction: DriverCompactionService;
	approval?: ApprovalService<unknown>;
	telemetry?: TelemetryContext;
	legacyExtensions?: readonly LegacyExtensionSpec[];
	legacyExtensionFlagValues?: ReadonlyMap<string, boolean | string>;
	legacyExtensionContext?: () => ExtensionContext;
	legacyExtensionCommandContext?: () => ExtensionCommandContext;
	systemPrompt?: string;
	systemPromptOptions?: Omit<BuildSystemPromptOptions, "cwd" | "selectedTools" | "toolSnippets" | "promptGuidelines">;
}

export interface CodingRuntime extends MinimalRuntime {
	cwd: string;
	sessionId: string;
	sessionPath: string;
	toolNames: readonly string[];
	skills: readonly Skill[];
	promptTemplates: readonly PromptTemplate[];
	resourceDiagnostics: readonly ResourceDiagnostic[];
	legacyExtensionSet: LegacyExtensionSetContribution;
	legacyCommands: readonly CodingRuntimeCommand[];
	legacyExtensionErrors: readonly ExtensionError[];
	flushLegacyActions(): Promise<void>;
	listSessions(options?: { cwd?: string }): Promise<JsonlSessionMetadata[]>;
	forkSession(options?: { id?: string; entryId?: string; position?: "before" | "at" }): Promise<JsonlSessionMetadata>;
}

export async function createCodingRuntime(options: CreateCodingRuntimeOptions): Promise<CodingRuntime> {
	if (options.tools && options.toolNames) throw new Error("tools cannot be combined with toolNames");
	if (options.skills && options.skillPaths) throw new Error("skills cannot be combined with skillPaths");
	if (options.promptTemplates && options.promptTemplatePaths) {
		throw new Error("promptTemplates cannot be combined with promptTemplatePaths");
	}
	const env = new NodeExecutionEnv({ cwd: options.cwd });
	const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: options.sessionsRoot });
	const session = await openOrCreateSession(repo, options.cwd, options.sessionId, options.parentSessionId);
	const selectedToolNames = options.toolNames ?? (options.tools ? [] : DEFAULT_CODING_TOOL_NAMES);
	const tools = options.tools
		? [...options.tools]
		: selectedToolNames.map((name) => createTool(name, options.cwd, options.toolOptions));
	const systemPrompt = options.systemPrompt ?? buildCodingRuntimeSystemPrompt(options, tools);
	const loadedSkills = options.skills
		? { skills: [...options.skills], diagnostics: [] }
		: loadSkills({
				cwd: options.cwd,
				agentDir: options.agentDir ?? getAgentDir(),
				skillPaths: [...(options.skillPaths ?? [])],
				includeDefaults: options.includeDefaultSkills ?? true,
				includeProjectDefaults: options.projectTrusted ?? true,
			});
	const loadedPromptTemplates = resolvePromptTemplates(options);
	const codingApprovalPlugin = createCodingApprovalPlugin(options.approval ?? new HeadlessApprovalService<unknown>());
	const codingToolsPlugin = createCodingToolsPlugin(toRegistrations(tools, options));
	const codingSkillsPlugin = createCodingSkillsPlugin(loadedSkills.skills);
	const codingCompactionPlugin = createCodingCompactionPlugin(options.compaction);
	const codingTelemetryPlugin = createCodingTelemetryPlugin(options.telemetry ?? NOOP_TELEMETRY_CONTEXT);
	const legacyExtensionErrors: ExtensionError[] = [];
	const legacyExtensionsPlugin = createLegacyExtensionSetPlugin({
		id: "pi-legacy-extensions",
		version: "0.1.0",
		cwd: options.cwd,
		extensions: options.legacyExtensions ?? [],
		service: LEGACY_EXTENSIONS_SERVICE,
	});
	const legacyExtensionBindingsPlugin = createLegacyExtensionBindingsPlugin(
		options.legacyExtensionContext,
		legacyExtensionErrors,
		{
			...options.systemPromptOptions,
			cwd: options.cwd,
			selectedTools: tools.map((tool) => tool.name),
			skills: [...loadedSkills.skills],
		},
	);
	const {
		cwd,
		sessionsRoot: _sessionsRoot,
		sessionId: _sessionId,
		parentSessionId: _parentSessionId,
		tools: _tools,
		toolNames: _toolNames,
		toolOptions: _toolOptions,
		skills: _skills,
		skillPaths: _skillPaths,
		includeDefaultSkills: _includeDefaultSkills,
		promptTemplates: _promptTemplates,
		promptTemplatePaths: _promptTemplatePaths,
		includeDefaultPromptTemplates: _includeDefaultPromptTemplates,
		projectTrusted: _projectTrusted,
		agentDir: _agentDir,
		compaction: _compaction,
		approval: _approval,
		telemetry: _telemetry,
		legacyExtensions: _legacyExtensions,
		legacyExtensionFlagValues: _legacyExtensionFlagValues,
		legacyExtensionContext: _legacyExtensionContext,
		legacyExtensionCommandContext: _legacyExtensionCommandContext,
		systemPrompt: _systemPrompt,
		systemPromptOptions: _systemPromptOptions,
		...runtimeOptions
	} = options;
	const runtime = await createComposedRuntime(
		{ ...runtimeOptions, session, systemPrompt },
		{
			profile: resolveCodingProfile(),
			sessionPluginId: "session-jsonl",
			plugins: [
				{ plugin: codingApprovalPlugin, config: undefined },
				{ plugin: codingToolsPlugin, config: undefined },
				{ plugin: codingSkillsPlugin, config: undefined },
				{ plugin: codingCompactionPlugin, config: undefined },
				{ plugin: codingTelemetryPlugin, config: undefined },
				{ plugin: legacyExtensionsPlugin, config: undefined },
				{ plugin: legacyExtensionBindingsPlugin, config: undefined },
			],
		},
	);
	const metadata = await session.getMetadata();
	const legacyExtensionSet = legacyExtensionsPlugin.getContribution();
	try {
		applyLegacyExtensionFlagValues(legacyExtensionSet, options.legacyExtensionFlagValues);
	} catch (error) {
		await runtime.dispose();
		throw error;
	}
	const legacyCommands = createLegacyExtensionCommands(
		legacyExtensionSet.extensions,
		options.legacyExtensionCommandContext,
	);
	const legacyRuntimeBinding = bindLegacyExtensionRuntimeActions({
		contribution: legacyExtensionSet,
		driver: runtime.driver,
		session,
		availableTools: runtime.toolCatalog.list(),
		toolReplay: runtime.toolCatalog.replayPolicies(),
		toolPolicyVersions: runtime.toolCatalog.policyVersions(),
		initialSessionName: await session.getName(),
		errors: legacyExtensionErrors,
	});
	const unsubscribeLegacyEvents = subscribeLegacyExtensionEvents({
		driver: runtime.driver,
		extensions: legacyExtensionSet.extensions,
		contextFactory: options.legacyExtensionContext,
		errors: legacyExtensionErrors,
	});
	return {
		...runtime,
		cwd,
		sessionId: metadata.id,
		sessionPath: metadata.path,
		get toolNames() {
			return runtime.driver.toolNames;
		},
		skills: Object.freeze([...loadedSkills.skills]),
		promptTemplates: Object.freeze([...loadedPromptTemplates.templates]),
		resourceDiagnostics: Object.freeze([...loadedSkills.diagnostics, ...loadedPromptTemplates.diagnostics]),
		legacyExtensionSet,
		legacyCommands: Object.freeze(legacyCommands),
		legacyExtensionErrors,
		flushLegacyActions: () => legacyRuntimeBinding.flush(),
		listSessions: (listOptions = { cwd }) => repo.list(listOptions),
		async forkSession(forkOptions = {}) {
			if (!runtime.driver.isIdle()) throw new Error("Cannot fork a Session while the Agent Driver is active");
			const recovery = await runtime.driver.getRecoveryState();
			if (recovery.status !== "idle") throw new Error(`Cannot fork while recovery status is ${recovery.status}`);
			await session.flush();
			const forked = await repo.fork(metadata, {
				cwd,
				...(forkOptions.id === undefined ? {} : { id: forkOptions.id }),
				scope: "branch",
				...(forkOptions.entryId === undefined ? {} : { entryId: forkOptions.entryId }),
				...(forkOptions.position === undefined ? {} : { position: forkOptions.position }),
			});
			await forked.flush();
			return forked.getMetadata();
		},
		async dispose() {
			unsubscribeLegacyEvents();
			await runtime.dispose();
		},
	};
}

function resolvePromptTemplates(options: CreateCodingRuntimeOptions): {
	templates: PromptTemplate[];
	diagnostics: ResourceDiagnostic[];
} {
	const prompts = options.promptTemplates
		? [...options.promptTemplates]
		: loadPromptTemplates({
				cwd: options.cwd,
				agentDir: options.agentDir ?? getAgentDir(),
				promptPaths: [...(options.promptTemplatePaths ?? [])],
				includeDefaults: options.includeDefaultPromptTemplates ?? false,
				includeProjectDefaults:
					(options.includeDefaultPromptTemplates ?? false) && (options.projectTrusted ?? true),
			});
	const unique = new Map<string, PromptTemplate>();
	const diagnostics: ResourceDiagnostic[] = [];
	for (const prompt of prompts) {
		const existing = unique.get(prompt.name);
		if (!existing) {
			unique.set(prompt.name, prompt);
			continue;
		}
		diagnostics.push({
			type: "collision",
			message: `name "/${prompt.name}" collision`,
			path: prompt.filePath,
			collision: {
				resourceType: "prompt",
				name: prompt.name,
				winnerPath: existing.filePath,
				loserPath: prompt.filePath,
			},
		});
	}
	return { templates: [...unique.values()], diagnostics };
}

function applyLegacyExtensionFlagValues(
	contribution: LegacyExtensionSetContribution,
	values: ReadonlyMap<string, boolean | string> | undefined,
): void {
	if (!values || values.size === 0) return;
	const registered = new Map<string, "boolean" | "string">();
	for (const extension of contribution.extensions) {
		for (const [name, flag] of extension.flags) registered.set(name, flag.type);
	}
	const errors: string[] = [];
	for (const [name, value] of values) {
		const type = registered.get(name);
		if (!type) {
			errors.push(`Unknown option: --${name}`);
			continue;
		}
		if (type === "boolean") {
			contribution.runtime.flagValues.set(name, true);
			continue;
		}
		if (typeof value !== "string") {
			errors.push(`Extension flag "--${name}" requires a value`);
			continue;
		}
		contribution.runtime.flagValues.set(name, value);
	}
	if (errors.length > 0) throw new Error(errors.join("\n"));
}

function createLegacyExtensionBindingsPlugin(
	contextFactory: (() => ExtensionContext) | undefined,
	errors: ExtensionError[],
	systemPromptOptions: BuildSystemPromptOptions,
): HarnessPlugin<undefined> {
	return {
		manifest: {
			id: "pi-legacy-extension-bindings",
			version: "0.1.0",
			provides: [
				MESSAGE_COMMIT_MIDDLEWARE_SERVICE,
				RUN_PREPARATION_MIDDLEWARE_SERVICE,
				TOOL_LIFECYCLE_MIDDLEWARE_SERVICE,
			],
			requires: [LEGACY_EXTENSIONS_SERVICE, TOOLS_SERVICE, PROMPT_SERVICE, APPROVAL_SERVICE],
		},
		async activate(context) {
			const contribution = context.require(LEGACY_EXTENSIONS_SERVICE);
			const tools = uniqueLegacyExtensionTools(contribution.extensions);
			const approval = context.require(APPROVAL_SERVICE);
			const catalog = context.require(TOOLS_SERVICE);
			context.provide(MESSAGE_COMMIT_MIDDLEWARE_SERVICE, {
				transform: (message) =>
					transformLegacyExtensionMessageEnd({
						message,
						extensions: contribution.extensions,
						contextFactory,
						errors,
					}),
			});
			context.provide(RUN_PREPARATION_MIDDLEWARE_SERVICE, {
				prepare: (preparation) =>
					prepareLegacyExtensionRun({
						preparation,
						extensions: contribution.extensions,
						contextFactory,
						errors,
						systemPromptOptions,
					}),
			});
			context.provide(TOOL_LIFECYCLE_MIDDLEWARE_SERVICE, {
				before: (toolContext) =>
					runLegacyExtensionBeforeTool({
						toolContext,
						extensions: contribution.extensions,
						contextFactory,
						errors,
					}),
				after: (toolContext) =>
					runLegacyExtensionAfterTool({
						toolContext,
						extensions: contribution.extensions,
						contextFactory,
						errors,
					}),
			});
			for (const registered of tools) {
				const tool = wrapToolDefinition(registered.definition, () => {
					if (!contextFactory) {
						throw new Error(
							`Legacy extension tool ${registered.definition.name} requires an Extension context binding`,
						);
					}
					return contextFactory();
				});
				await context.effect(() =>
					catalog.register({
						tool,
						replay: "never",
						policyVersion: LEGACY_EXTENSION_POLICY_VERSION,
						pipeline: { approval: { required: true, service: approval } },
					}),
				);
			}
			await context.effect(() =>
				context.require(PROMPT_SERVICE).register({
					id: "pi-legacy-extension-tools",
					priority: 50,
					contribute: () => formatLegacyExtensionTools(tools),
				}),
			);
		},
	};
}

function uniqueLegacyExtensionTools(extensions: LegacyExtensionSetContribution["extensions"]): RegisteredTool[] {
	const tools = new Map<string, RegisteredTool>();
	for (const extension of extensions) {
		for (const registered of extension.tools.values()) {
			if (!tools.has(registered.definition.name)) tools.set(registered.definition.name, registered);
		}
	}
	return [...tools.values()];
}

function formatLegacyExtensionTools(tools: readonly RegisteredTool[]): string | undefined {
	if (tools.length === 0) return undefined;
	const descriptions = tools.map(
		({ definition }) => `- ${definition.name}: ${definition.promptSnippet ?? definition.description}`,
	);
	const guidelines = tools.flatMap(({ definition }) => definition.promptGuidelines ?? []);
	return [
		"<extension_tools>",
		...descriptions,
		...(guidelines.length > 0 ? ["", "Extension tool guidelines:", ...guidelines.map((item) => `- ${item}`)] : []),
		"</extension_tools>",
	].join("\n");
}

function createCodingApprovalPlugin(service: ApprovalService<unknown>): HarnessPlugin<undefined> {
	return {
		manifest: { id: "pi-coding-approval", version: "0.1.0", provides: [APPROVAL_SERVICE] },
		activate(context) {
			context.provide(APPROVAL_SERVICE, service);
		},
	};
}

function createCodingTelemetryPlugin(telemetry: TelemetryContext): HarnessPlugin<undefined> {
	return {
		manifest: { id: "pi-coding-telemetry", version: "0.1.0", provides: [TELEMETRY_SERVICE] },
		activate(context) {
			context.provide(TELEMETRY_SERVICE, telemetry);
		},
	};
}

function createCodingCompactionPlugin(service: DriverCompactionService): HarnessPlugin<undefined> {
	return {
		manifest: { id: "pi-coding-compaction", version: "0.1.0", provides: [COMPACTION_SERVICE] },
		activate(context) {
			context.provide(COMPACTION_SERVICE, service);
		},
	};
}

function createCodingToolsPlugin(registrations: readonly ToolCatalogRegistration[]): HarnessPlugin<undefined> {
	return {
		manifest: {
			id: "pi-coding-tools",
			version: "0.1.0",
			requires: [TOOLS_SERVICE, APPROVAL_SERVICE],
		},
		activate(context) {
			const catalog = context.require(TOOLS_SERVICE);
			const approval = context.require(APPROVAL_SERVICE);
			const unregister = registrations.map((registration) =>
				catalog.register(withDefaultApproval(registration, approval)),
			);
			return () => {
				for (let index = unregister.length - 1; index >= 0; index--) unregister[index]!();
			};
		},
	};
}

function withDefaultApproval(
	registration: ToolCatalogRegistration,
	service: ApprovalService<unknown>,
): ToolCatalogRegistration {
	if (!APPROVAL_REQUIRED_TOOLS.has(registration.tool.name as ToolName)) return registration;
	const pipeline: ToolPipeline<unknown, AgentToolResult<unknown>> = {
		...registration.pipeline,
		approval: registration.pipeline?.approval ?? { required: true, service },
	};
	return {
		...registration,
		policyVersion: registration.policyVersion ?? DEFAULT_APPROVAL_POLICY_VERSION,
		pipeline,
	};
}

function createCodingSkillsPlugin(skills: readonly Skill[]): HarnessPlugin<undefined> {
	return {
		manifest: { id: "pi-coding-skills", version: "0.1.0", requires: [PROMPT_SERVICE] },
		activate(context) {
			return context.require(PROMPT_SERVICE).register({
				id: "pi-coding-skills",
				priority: 100,
				contribute: () => formatSkillsForPrompt([...skills]),
			});
		},
	};
}

function toRegistrations(
	tools: readonly AgentTool[],
	options: Pick<CreateCodingRuntimeOptions, "toolPolicies" | "toolReplay">,
): ToolCatalogRegistration[] {
	return tools.map((tool) => {
		const policy = options.toolPolicies?.[tool.name];
		return {
			tool,
			replay: options.toolReplay?.[tool.name] ?? (SAFE_REPLAY_TOOLS.has(tool.name as ToolName) ? "safe" : "never"),
			policyVersion: policy?.version,
			pipeline: policy?.pipeline,
		};
	});
}

function buildCodingRuntimeSystemPrompt(
	options: Pick<CreateCodingRuntimeOptions, "cwd" | "systemPromptOptions">,
	tools: readonly AgentTool[],
): string {
	const toolNames = tools.map((tool) => tool.name);
	return buildSystemPrompt({
		...options.systemPromptOptions,
		cwd: options.cwd,
		selectedTools: toolNames,
		toolSnippets: Object.fromEntries(
			tools.map((tool) => [tool.name, isToolName(tool.name) ? TOOL_PROMPTS[tool.name].snippet : tool.description]),
		),
		promptGuidelines: toolNames.flatMap((name) => (isToolName(name) ? TOOL_PROMPTS[name].guidelines : [])),
	});
}

function isToolName(name: string): name is ToolName {
	return Object.hasOwn(TOOL_PROMPTS, name);
}

async function openOrCreateSession(
	repo: JsonlSessionRepo,
	cwd: string,
	sessionId: string | undefined,
	parentSessionId: string | undefined,
): Promise<Session<JsonlSessionMetadata>> {
	const existing = sessionId ? (await repo.list({ cwd })).find((metadata) => metadata.id === sessionId) : undefined;
	return existing ? repo.open(existing) : repo.create({ cwd, id: sessionId, parentSessionId });
}
