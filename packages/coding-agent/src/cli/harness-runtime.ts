import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { createModelBackedCodingRuntime } from "../core/coding-model-runtime.ts";
import type { CodingRuntime } from "../core/coding-runtime.ts";
import { CodingRuntimeHost } from "../core/coding-runtime-host.ts";
import { DEFAULT_THINKING_LEVEL } from "../core/defaults.ts";
import {
	createHarnessExtensionContexts,
	importExtensionFactory,
	type LegacyExtensionSpec,
} from "../core/extensions/index.ts";
import { ModelRegistry } from "../core/model-registry.ts";
import { resolveCliModel } from "../core/model-resolver.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { loadProjectContextFiles } from "../core/resource-loader.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { allToolNames, type ToolName } from "../core/tools/index.ts";
import { runCodingPrintMode } from "../modes/coding-print-mode.ts";
import { HarnessRpcApprovalService } from "../modes/rpc/harness-rpc-approval.ts";
import { runHarnessRpcMode } from "../modes/rpc/harness-rpc-mode.ts";
import { stripBom } from "../utils/text.ts";
import { type Args, type Mode, normalizeSessionName } from "./args.ts";
import { createInteractiveHarnessApproval, type HarnessApprovalPrompt } from "./harness-approval.ts";

const DEFAULT_TOOL_NAMES: readonly ToolName[] = ["read", "bash", "edit", "write"];

export interface RunHarnessCliRuntimeOptions {
	parsed: Args;
	mode: Mode;
	cwd: string;
	agentDir: string;
	sessionsRoot: string;
	settingsManager: SettingsManager;
	offline: boolean;
	initialMessage?: string;
	initialImages?: ImageContent[];
	approvalPrompt?: HarnessApprovalPrompt;
	projectTrusted?: boolean;
}

export function validateHarnessCliRuntimeArgs(options: RunHarnessCliRuntimeOptions): void {
	const { parsed } = options;
	const unsupported: string[] = [];
	if (parsed.resume) unsupported.push("--resume");
	if (parsed.fork) unsupported.push("--fork");
	if (parsed.noSession) unsupported.push("--no-session");
	if (parsed.promptTemplates?.length) unsupported.push("--prompt-template");
	if (parsed.themes?.length || parsed.useTheme) unsupported.push("--theme/--use-theme");
	if (parsed.models?.length) unsupported.push("--models");
	if (unsupported.length > 0) {
		throw new Error(`--harness-runtime does not support ${unsupported.join(", ")} yet`);
	}
}

export function resolveHarnessToolNames(parsed: Args, settingsManager: SettingsManager): ToolName[] {
	if (parsed.noTools || parsed.noBuiltinTools) return [];
	const requested = parsed.tools ?? settingsManager.getDefaultTools() ?? [...DEFAULT_TOOL_NAMES];
	const invalid = requested.filter((name) => !allToolNames.has(name as ToolName));
	if (invalid.length > 0) {
		throw new Error(`Unknown built-in tool(s) for --harness-runtime: ${invalid.join(", ")}`);
	}
	const excluded = new Set(parsed.excludeTools ?? []);
	return requested.filter((name): name is ToolName => allToolNames.has(name as ToolName) && !excluded.has(name));
}

export async function resolveHarnessSessionId(
	parsed: Args,
	cwd: string,
	sessionsRoot: string,
): Promise<string | undefined> {
	if (parsed.sessionId) return parsed.sessionId;
	if (parsed.session) {
		const env = new NodeExecutionEnv({ cwd });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot });
		const requestedPath = resolve(cwd, parsed.session);
		const match = (await repo.list({ cwd })).find(
			(metadata) => metadata.id === parsed.session || resolve(metadata.path) === requestedPath,
		);
		if (!match) throw new Error(`Harness session was not found: ${parsed.session}`);
		return match.id;
	}
	if (!parsed.continue) return undefined;
	const env = new NodeExecutionEnv({ cwd });
	const repo = new JsonlSessionRepo({ fs: env, sessionsRoot });
	return (await repo.list({ cwd }))[0]?.id;
}

export async function runHarnessCliRuntime(options: RunHarnessCliRuntimeOptions): Promise<number> {
	validateHarnessCliRuntimeArgs(options);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(options.agentDir, "auth.json"),
		modelsPath: join(options.agentDir, "models.json"),
		modelsStorePath: join(options.agentDir, "models-store.json"),
		allowModelNetwork: !options.offline,
		modelRefreshTimeoutMs: 15_000,
		signal: AbortSignal.timeout(15_000),
	});
	const selection = resolveHarnessModel(options.parsed, options.settingsManager, modelRuntime);
	if (options.parsed.apiKey) {
		await modelRuntime.setRuntimeApiKey(selection.model.provider, options.parsed.apiKey, {
			signal: AbortSignal.timeout(15_000),
		});
	}
	const sessionId = await resolveHarnessSessionId(options.parsed, options.cwd, options.sessionsRoot);
	const legacyExtensions = await loadHarnessLegacyExtensions(options.parsed.extensions ?? [], options.cwd);
	const rpcApproval = options.mode === "rpc" ? new HarnessRpcApprovalService() : undefined;
	const systemPromptOptions = {
		customPrompt: resolvePromptInput(options.parsed.systemPrompt),
		appendSystemPrompt: options.parsed.appendSystemPrompt?.map(resolvePromptInput).join("\n\n"),
		contextFiles: options.parsed.noContextFiles
			? []
			: loadProjectContextFiles({
					cwd: options.cwd,
					agentDir: options.agentDir,
					includeProject: options.projectTrusted ?? false,
				}),
	};
	let runtime: CodingRuntime | undefined;
	let runtimeHost: CodingRuntimeHost | undefined;
	const extensionContexts = createHarnessExtensionContexts({
		cwd: options.cwd,
		mode: options.mode === "text" ? "print" : options.mode,
		modelRegistry: new ModelRegistry(modelRuntime),
		systemPromptOptions: { cwd: options.cwd, ...systemPromptOptions },
		getRuntime: () => {
			if (runtimeHost) {
				const snapshot = runtimeHost.snapshot;
				return {
					driver: runtimeHost.controller.driver,
					sessionId: snapshot.session.id,
					sessionPath: snapshot.session.path,
					getSessionName: () => snapshot.session.name,
				};
			}
			if (!runtime) throw new Error("Coding Runtime is not active");
			return {
				driver: runtime.driver,
				sessionId: runtime.sessionId,
				sessionPath: runtime.sessionPath,
				getSessionName: () => runtime!.legacyExtensionSet.runtime.getSessionName(),
			};
		},
		isProjectTrusted: options.projectTrusted ?? false,
	});
	const createRuntime = (targetSessionId: string | undefined) =>
		createModelBackedCodingRuntime({
			cwd: options.cwd,
			sessionsRoot: options.sessionsRoot,
			sessionId: targetSessionId,
			agentDir: options.agentDir,
			models: modelRuntime,
			model: selection.model,
			thinkingLevel: selection.thinkingLevel,
			compactionSettings: options.settingsManager.getCompactionSettings(),
			approval:
				rpcApproval ?? (options.approvalPrompt ? createInteractiveHarnessApproval(options.approvalPrompt) : undefined),
			toolNames: resolveHarnessToolNames(options.parsed, options.settingsManager),
			skillPaths: options.parsed.skills,
			includeDefaultSkills: !options.parsed.noSkills,
			projectTrusted: options.projectTrusted ?? false,
			legacyExtensions,
			legacyExtensionFlagValues: options.parsed.unknownFlags,
			legacyExtensionContext: extensionContexts.context,
			legacyExtensionCommandContext: extensionContexts.commandContext,
			systemPromptOptions,
		});
	runtime = await createRuntime(sessionId);
	if (options.parsed.name !== undefined) {
		const name = normalizeSessionName(options.parsed.name);
		if (!name) throw new Error("--name requires a non-empty value");
		await runtime.session.setName(name);
		await runtime.session.flush();
	}
	if (options.mode === "rpc") {
		runtimeHost = await CodingRuntimeHost.create(runtime, createRuntime);
		return runHarnessRpcMode(runtime, {
			approval: rpcApproval,
			host: runtimeHost,
			resolveModel: (provider, model) => modelRuntime.getModel(provider, model),
		});
	}
	return runCodingPrintMode(runtime, {
		mode: options.mode,
		initialInput: createInitialInput(options.initialMessage, options.initialImages),
		messages: options.parsed.messages,
	});
}

function createInitialInput(
	message: string | undefined,
	images: ImageContent[] | undefined,
): string | AgentMessage | undefined {
	if (!images || images.length === 0) return message;
	return {
		role: "user",
		content: [...(message ? [{ type: "text" as const, text: message }] : []), ...images],
		timestamp: Date.now(),
	};
}

export async function loadHarnessLegacyExtensions(
	paths: readonly string[],
	cwd: string,
): Promise<LegacyExtensionSpec[]> {
	return Promise.all(
		paths.map(async (extensionPath) => ({
			extensionPath,
			factory: await importExtensionFactory(extensionPath, cwd),
		})),
	);
}

function resolveHarnessModel(
	parsed: Args,
	settingsManager: SettingsManager,
	modelRuntime: ModelRuntime,
): { model: Model<Api>; thinkingLevel: ThinkingLevel } {
	if (parsed.provider && !parsed.model) {
		throw new Error("--provider requires --model when using --harness-runtime");
	}
	const cliSelection = resolveCliModel({
		cliProvider: parsed.provider,
		cliModel: parsed.model,
		cliThinking: parsed.thinking,
		modelRuntime,
	});
	if (cliSelection.error) throw new Error(cliSelection.error);
	if (cliSelection.warning) console.error(`Warning: ${cliSelection.warning}`);
	let model = cliSelection.model;
	if (!model) {
		const defaultProvider = settingsManager.getDefaultProvider();
		const defaultModel = settingsManager.getDefaultModel();
		model = defaultProvider && defaultModel ? modelRuntime.getModel(defaultProvider, defaultModel) : undefined;
	}
	model ??= modelRuntime.getAvailableSnapshot()[0];
	if (!model) {
		throw new Error("No authenticated model is available. Configure a model or pass --model and --api-key.");
	}
	const thinkingLevel =
		parsed.thinking ??
		cliSelection.thinkingLevel ??
		settingsManager.getModelThinkingLevel(model.provider, model.id) ??
		settingsManager.getDefaultThinkingLevel() ??
		DEFAULT_THINKING_LEVEL;
	return { model, thinkingLevel };
}

function resolvePromptInput(input: string): string;
function resolvePromptInput(input: string | undefined): string | undefined;
function resolvePromptInput(input: string | undefined): string | undefined {
	if (!input || !existsSync(input)) return input;
	return stripBom(readFileSync(input, "utf8"));
}
