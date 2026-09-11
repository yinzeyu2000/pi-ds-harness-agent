/**
 * Core modules shared between all run modes.
 */

export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type PromptOptions,
	type SessionStats,
} from "./agent-session.ts";
export {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	createAgentSessionRuntime,
} from "./agent-session-runtime.ts";
export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
export { type BashExecutorOptions, type BashResult, executeBashWithOperations } from "./bash-executor.ts";
export {
	type CreateModelBackedCodingRuntimeOptions,
	type CreateModelCompactionServiceOptions,
	createModelBackedCodingRuntime,
	createModelCompactionService,
} from "./coding-model-runtime.ts";
export {
	type CodingRuntime,
	type CreateCodingRuntimeOptions,
	createCodingRuntime,
} from "./coding-runtime.ts";
export {
	type CodingRuntimeCommandInfo,
	CodingRuntimeController,
	type CodingRuntimeDelivery,
} from "./coding-runtime-controller.ts";
export {
	type CodingRuntimeFactory,
	CodingRuntimeHost,
	type CodingRuntimeReplacement,
} from "./coding-runtime-host.ts";
export {
	CodingRuntimeProjection,
	type CodingRuntimeSnapshot,
	type CodingRuntimeSnapshotListener,
	readCodingRuntimeSnapshot,
} from "./coding-runtime-projection.ts";
export type { CompactionResult } from "./compaction/index.ts";
export { createEventBus, type EventBus, type EventBusController } from "./event-bus.ts";
export { areExperimentalFeaturesEnabled } from "./experimental.ts";
// Extensions system
export {
	type AgentEndEvent,
	type AgentSettledEvent,
	type AgentStartEvent,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	type BuildSystemPromptOptions,
	type CodingRuntimeCommand,
	type ContextEvent,
	createLegacyExtensionPlugin,
	createLegacyExtensionSetPlugin,
	defineTool,
	discoverAndLoadExtensions,
	type ExecOptions,
	type ExecResult,
	type Extension,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionError,
	type ExtensionEvent,
	type ExtensionFactory,
	type ExtensionFlag,
	type ExtensionHandler,
	ExtensionRunner,
	type ExtensionShortcut,
	type ExtensionUIContext,
	type InlineExtension,
	LEGACY_EXTENSIONS_SERVICE,
	type LegacyExtensionAdapterOptions,
	type LegacyExtensionContribution,
	type LegacyExtensionSetAdapterOptions,
	type LegacyExtensionSetContribution,
	type LegacyExtensionSetPlugin,
	type LegacyExtensionSpec,
	type LoadExtensionsResult,
	type MessageRenderer,
	type RegisteredCommand,
	type SessionBeforeCompactEvent,
	type SessionBeforeForkEvent,
	type SessionBeforeSwitchEvent,
	type SessionBeforeTreeEvent,
	type SessionCompactEvent,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type SessionTreeEvent,
	type ToolCallEvent,
	type ToolCallEventResult,
	type ToolDefinition,
	type ToolRenderResultOptions,
	type ToolResultEvent,
	type TurnEndEvent,
	type TurnStartEvent,
	type WorkingIndicatorOptions,
} from "./extensions/index.ts";
export { createSyntheticSourceInfo } from "./source-info.ts";
