import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { createModelBackedCodingRuntime } from "../core/coding-model-runtime.ts";
import type { CodingRuntime } from "../core/coding-runtime.ts";
import { CodingRuntimeHost, type CodingRuntimeTarget } from "../core/coding-runtime-host.ts";
import { DEFAULT_THINKING_LEVEL } from "../core/defaults.ts";
import {
	createHarnessExtensionContexts,
	importExtensionFactory,
	type LegacyExtensionSpec,
} from "../core/extensions/index.ts";
import { ModelRegistry } from "../core/model-registry.ts";
import { resolveCliModel, resolveModelScope, type ScopedModel } from "../core/model-resolver.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { loadProjectContextFiles } from "../core/resource-loader.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { allToolNames, type ToolName } from "../core/tools/index.ts";
import { runCodingPrintMode } from "../modes/coding-print-mode.ts";
import { CodingInteractiveMode, PiCodingInteractiveView } from "../modes/interactive/coding-interactive-mode.ts";
import { HarnessRpcApprovalService } from "../modes/rpc/harness-rpc-approval.ts";
import { HarnessRpcExtensionUIService } from "../modes/rpc/harness-rpc-extension-ui.ts";
import { runHarnessRpcMode } from "../modes/rpc/harness-rpc-mode.ts";
import { stripBom } from "../utils/text.ts";
import { type Args, type Mode, normalizeSessionName } from "./args.ts";
import { createInteractiveHarnessApproval, type HarnessApprovalPrompt } from "./harness-approval.ts";

const DEFAULT_TOOL_NAMES: readonly ToolName[] = ["read", "bash", "edit", "write"];

export type HarnessCliMode = Mode | "interactive";

export interface RunHarnessCliRuntimeOptions {
	parsed: Args;
	mode: HarnessCliMode;
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
	if (parsed.noSession) unsupported.push("--no-session");
	if (parsed.themes?.length || (parsed.useTheme && options.mode !== "interactive")) {
		unsupported.push("--theme/--use-theme");
	}
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
	if (parsed.fork) {
		const env = new NodeExecutionEnv({ cwd });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot });
		const sessions = await repo.list();
		const requestedPath = resolve(cwd, parsed.fork);
		const pathMatch = sessions.find(({ path }) => resolve(path) === requestedPath);
		const idMatches = sessions.filter(({ id }) => id === parsed.fork);
		const localIdMatches = idMatches.filter((metadata) => resolve(metadata.cwd) === resolve(cwd));
		const source =
			pathMatch ??
			(localIdMatches.length === 1 ? localIdMatches[0] : idMatches.length === 1 ? idMatches[0] : undefined);
		if (!source) {
			if (idMatches.length > 1) {
				throw new Error(`Harness session id is ambiguous across projects; use its JSONL path: ${parsed.fork}`);
			}
			throw new Error(`Harness session was not found: ${parsed.fork}`);
		}
		const forked = await repo.fork(source, {
			scope: "branch",
			cwd,
			...(parsed.sessionId === undefined ? {} : { id: parsed.sessionId }),
		});
		return (await forked.getMetadata()).id;
	}
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
	const modelPatterns = options.parsed.models ?? options.settingsManager.getEnabledModels();
	const scopedModels =
		modelPatterns && modelPatterns.length > 0
			? await resolveModelScope(modelPatterns, modelRuntime, { signal: AbortSignal.timeout(15_000) })
			: [];
	const modelsScoped = scopedModels.length > 0;
	const selection = resolveHarnessModel(options.parsed, options.settingsManager, modelRuntime, scopedModels);
	let activeModel = selection.model;
	let activeThinkingLevel = selection.thinkingLevel;
	const configuredToolNames = resolveHarnessToolNames(options.parsed, options.settingsManager);
	const promptTemplatePaths = options.parsed.promptTemplates?.map((path) => resolve(options.cwd, path));
	let activeToolNames: string[] | undefined;
	if (options.parsed.apiKey) {
		await modelRuntime.setRuntimeApiKey(selection.model.provider, options.parsed.apiKey, {
			signal: AbortSignal.timeout(15_000),
		});
	}
	const sessionId = await resolveHarnessSessionId(options.parsed, options.cwd, options.sessionsRoot);
	const legacyExtensions = await loadHarnessLegacyExtensions(options.parsed.extensions ?? [], options.cwd);
	const rpcApproval = options.mode === "rpc" ? new HarnessRpcApprovalService() : undefined;
	const rpcExtensionUI = options.mode === "rpc" ? new HarnessRpcExtensionUIService() : undefined;
	const interactiveView =
		options.mode === "interactive"
			? new PiCodingInteractiveView({
					tuiMode: options.parsed.tuiMode ?? options.settingsManager.getTuiMode(),
					showHardwareCursor: options.settingsManager.getShowHardwareCursor(),
					clearOnShrink: options.settingsManager.getClearOnShrink(),
					logDirectory: options.agentDir,
					fullscreenCopyOnSelect: options.settingsManager.getFullscreenCopyOnSelect(),
				})
			: undefined;
	let runtime: CodingRuntime | undefined;
	let runtimeHost: CodingRuntimeHost | undefined;
	const modelRegistry = new ModelRegistry(modelRuntime);
	const getRuntime = () => {
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
	};
	const getRuntimeHost = () => {
		if (!runtimeHost) throw new Error("Coding Runtime Host is not active");
		return runtimeHost;
	};
	const listSelectableModels = (): readonly Model<Api>[] =>
		modelsScoped ? scopedModels.map(({ model }) => model) : modelRuntime.getAvailableSnapshot();
	const handleModelChanged = async (model: Model<Api>) => {
		activeModel = model;
		let scoped = scopedModels.find(
			(candidate) => candidate.model.provider === model.provider && candidate.model.id === model.id,
		);
		if (modelsScoped && !scoped) {
			scoped = { model };
			scopedModels.push(scoped);
		}
		if (scoped?.thinkingLevel !== undefined) {
			activeThinkingLevel = scoped.thinkingLevel;
			await getRuntimeHost().controller.setThinkingLevel(scoped.thinkingLevel);
		}
	};
	const resolveSessionMetadata = async (reference: string) => {
		const host = getRuntimeHost();
		const sessions = await host.controller.listSessions("all");
		const resolvedReference = resolve(host.snapshot.session.cwd, reference);
		const matches = sessions.filter(({ id, path }) => id === reference || resolve(path) === resolvedReference);
		if (matches.length === 1) return matches[0]!;
		if (matches.length > 1) {
			throw new Error(`Session id is ambiguous across projects; use its JSONL path: ${reference}`);
		}
		throw new Error(`Harness session was not found: ${reference}`);
	};
	const initialCwd = resolve(options.cwd);
	const createRuntime = async (target: CodingRuntimeTarget) => {
		if (runtimeHost) interactiveView?.resetExtensionUI();
		const targetCwd = resolve(target.cwd);
		const projectTrusted = targetCwd === initialCwd && (options.projectTrusted ?? false);
		const systemPromptOptions = {
			customPrompt: resolvePromptInput(options.parsed.systemPrompt),
			appendSystemPrompt: options.parsed.appendSystemPrompt?.map(resolvePromptInput).join("\n\n"),
			contextFiles: options.parsed.noContextFiles
				? []
				: loadProjectContextFiles({
						cwd: targetCwd,
						agentDir: options.agentDir,
						includeProject: projectTrusted,
					}),
		};
		const extensionContexts = createHarnessExtensionContexts({
			cwd: targetCwd,
			mode: options.mode === "text" ? "print" : options.mode === "interactive" ? "tui" : options.mode,
			modelRegistry,
			systemPromptOptions: { cwd: targetCwd, ...systemPromptOptions },
			getRuntime,
			isProjectTrusted: projectTrusted,
			ui: rpcExtensionUI?.context ?? interactiveView?.getExtensionUIContext(),
			hasUI: rpcExtensionUI !== undefined || interactiveView !== undefined,
			sessionOperations: {
				async newSession(parentSession) {
					const host = getRuntimeHost();
					const parentSessionId = parentSession ? (await resolveSessionMetadata(parentSession)).id : undefined;
					await host.newSession({
						cwd: host.snapshot.session.cwd,
						...(parentSessionId === undefined ? {} : { parentSessionId }),
					});
				},
				async fork(entryId, position) {
					await getRuntimeHost().forkAndSwitch({ entryId, position });
				},
				async switchSession(sessionPath) {
					const metadata = await resolveSessionMetadata(sessionPath);
					await getRuntimeHost().switchSession({ sessionId: metadata.id, cwd: metadata.cwd });
				},
				async reload() {
					await getRuntimeHost().reload();
				},
			},
		});
		const created = await createModelBackedCodingRuntime({
			cwd: targetCwd,
			sessionsRoot: options.sessionsRoot,
			sessionId: target.sessionId,
			parentSessionId: target.parentSessionId,
			agentDir: options.agentDir,
			models: modelRuntime,
			model: activeModel,
			thinkingLevel: activeThinkingLevel,
			compactionSettings: options.settingsManager.getCompactionSettings(),
			approval:
				rpcApproval ??
				(interactiveView
					? createInteractiveHarnessApproval((message, signal) => interactiveView.requestApproval(message, signal))
					: options.approvalPrompt
						? createInteractiveHarnessApproval(options.approvalPrompt)
						: undefined),
			toolNames:
				activeToolNames?.filter((name): name is ToolName => allToolNames.has(name as ToolName)) ??
				configuredToolNames,
			skillPaths: options.parsed.skills,
			includeDefaultSkills: !options.parsed.noSkills,
			promptTemplatePaths,
			includeDefaultPromptTemplates: !options.parsed.noPromptTemplates,
			projectTrusted,
			legacyExtensions,
			legacyExtensionFlagValues: options.parsed.unknownFlags,
			legacyExtensionContext: extensionContexts.context,
			legacyExtensionCommandContext: extensionContexts.commandContext,
			systemPromptOptions,
		});
		if (activeToolNames) created.legacyExtensionSet.runtime.setActiveTools(activeToolNames);
		return created;
	};
	runtime = await createRuntime({ sessionId, cwd: initialCwd });
	activeToolNames = [...runtime.toolNames];
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
			extensionUI: rpcExtensionUI,
			host: runtimeHost,
			resolveModel: (provider, model) => modelRuntime.getModel(provider, model),
			listModels: listSelectableModels,
			modelsScoped,
			onModelChanged: handleModelChanged,
			onThinkingLevelChanged: (level) => {
				activeThinkingLevel = level;
			},
			onToolsChanged: (names) => {
				activeToolNames = [...names];
			},
		});
	}
	if (options.mode === "interactive") {
		runtimeHost = await CodingRuntimeHost.create(runtime, createRuntime);
		return new CodingInteractiveMode(runtimeHost, {
			view: interactiveView!,
			availableModels: listSelectableModels,
			onModelChanged: handleModelChanged,
			onThinkingLevelChanged: (level) => {
				activeThinkingLevel = level;
			},
			onToolsChanged: (names) => {
				activeToolNames = [...names];
			},
			initialInputs: [
				createInitialInput(options.initialMessage, options.initialImages),
				...options.parsed.messages,
			].filter((input): input is string | AgentMessage => input !== undefined),
		}).run();
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
	scopedModels: readonly ScopedModel[],
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
	let scopedThinkingLevel: ThinkingLevel | undefined;
	if (!model) {
		const defaultProvider = settingsManager.getDefaultProvider();
		const defaultModel = settingsManager.getDefaultModel();
		const savedScopedModel = scopedModels.find(
			({ model: candidate }) => candidate.provider === defaultProvider && candidate.id === defaultModel,
		);
		const scopedModel = savedScopedModel ?? scopedModels[0];
		model = scopedModel?.model;
		scopedThinkingLevel = scopedModel?.thinkingLevel;
		model ??= defaultProvider && defaultModel ? modelRuntime.getModel(defaultProvider, defaultModel) : undefined;
	}
	model ??= modelRuntime.getAvailableSnapshot()[0];
	if (!model) {
		throw new Error("No authenticated model is available. Configure a model or pass --model and --api-key.");
	}
	const thinkingLevel =
		parsed.thinking ??
		cliSelection.thinkingLevel ??
		scopedThinkingLevel ??
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
