import {
	AGENT_DRIVER_SERVICE,
	APPROVAL_SERVICE,
	COMPACTION_SERVICE,
	MESSAGE_COMMIT_MIDDLEWARE_SERVICE,
	MINIMAL_BUNDLE,
	MINIMAL_PLUGIN_CONTRACTS,
	PROMPT_SERVICE,
	RUN_PREPARATION_MIDDLEWARE_SERVICE,
	SESSION_SERVICE,
	TELEMETRY_SERVICE,
	TOOL_LIFECYCLE_MIDDLEWARE_SERVICE,
	TOOLS_SERVICE,
} from "./minimal-runtime.ts";
import { type Bundle, composeProfile, type Profile, type ResolvedProfile } from "./profile.ts";
import { createResolvedManifest, type PluginContract, type ResolvedManifestV1 } from "./resolved-manifest.ts";

export const CODING_APPROVAL_SERVICE_ID = APPROVAL_SERVICE.id;
export const LEGACY_EXTENSIONS_SERVICE_ID = "pi-ds.coding.legacy-extensions";

export const CODING_BUNDLE: Bundle = {
	id: "coding",
	plugins: [
		{ id: "coding-skills", plugin: "pi-coding-skills", scope: "agent" },
		{ id: "coding-compaction", plugin: "pi-coding-compaction", scope: "agent" },
		{ id: "coding-approval", plugin: "pi-coding-approval", scope: "agent" },
		{ id: "coding-telemetry", plugin: "pi-coding-telemetry", scope: "agent" },
		{ id: "legacy-extensions", plugin: "pi-legacy-extensions", scope: "agent" },
		{ id: "legacy-extension-bindings", plugin: "pi-legacy-extension-bindings", scope: "agent" },
		{ id: "coding-ui", plugin: "pi-coding-ui", enabled: false, scope: "agent" },
	],
};

export const CODING_PROFILE: Profile = {
	id: "coding",
	bundles: [MINIMAL_BUNDLE.id, CODING_BUNDLE.id],
	patches: [
		{
			operation: "replace",
			id: "session-memory",
			spec: {
				id: "session-jsonl",
				plugin: "session-jsonl",
				scope: "agent",
				config: { format: "jsonl", recovery: "truncate-invalid-tail" },
			},
		},
		{
			operation: "insert",
			after: "tools",
			spec: { id: "coding-tools", plugin: "pi-coding-tools", scope: "agent" },
		},
	],
};

export const CODING_PLUGIN_CONTRACTS: ReadonlyMap<string, PluginContract> = new Map([
	...MINIMAL_PLUGIN_CONTRACTS,
	["session-jsonl", { plugin: "session-jsonl", provides: [SESSION_SERVICE.id] }],
	["pi-coding-tools", { plugin: "pi-coding-tools", requires: [TOOLS_SERVICE.id, APPROVAL_SERVICE.id] }],
	["pi-coding-skills", { plugin: "pi-coding-skills", requires: [PROMPT_SERVICE.id] }],
	["pi-coding-compaction", { plugin: "pi-coding-compaction", provides: [COMPACTION_SERVICE.id] }],
	["pi-coding-approval", { plugin: "pi-coding-approval", provides: [CODING_APPROVAL_SERVICE_ID] }],
	["pi-coding-telemetry", { plugin: "pi-coding-telemetry", provides: [TELEMETRY_SERVICE.id] }],
	["pi-legacy-extensions", { plugin: "pi-legacy-extensions", provides: [LEGACY_EXTENSIONS_SERVICE_ID] }],
	[
		"pi-legacy-extension-bindings",
		{
			plugin: "pi-legacy-extension-bindings",
			provides: [
				MESSAGE_COMMIT_MIDDLEWARE_SERVICE.id,
				RUN_PREPARATION_MIDDLEWARE_SERVICE.id,
				TOOL_LIFECYCLE_MIDDLEWARE_SERVICE.id,
			],
			requires: [LEGACY_EXTENSIONS_SERVICE_ID, TOOLS_SERVICE.id, PROMPT_SERVICE.id, APPROVAL_SERVICE.id],
		},
	],
	[
		"pi-coding-ui",
		{
			plugin: "pi-coding-ui",
			requires: [SESSION_SERVICE.id, AGENT_DRIVER_SERVICE.id, CODING_APPROVAL_SERVICE_ID],
		},
	],
]);

export function resolveCodingProfile(): ResolvedProfile {
	return composeProfile(
		CODING_PROFILE,
		new Map([
			[MINIMAL_BUNDLE.id, MINIMAL_BUNDLE],
			[CODING_BUNDLE.id, CODING_BUNDLE],
		]),
	);
}

export function resolveCodingManifest(): ResolvedManifestV1 {
	return createResolvedManifest(resolveCodingProfile(), CODING_PLUGIN_CONTRACTS);
}
