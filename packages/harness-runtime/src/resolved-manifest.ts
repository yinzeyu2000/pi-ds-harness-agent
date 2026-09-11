import type { ResolvedPluginSpec, ResolvedProfile } from "./profile.ts";

export interface PluginContract {
	plugin: string;
	provides?: readonly string[];
	requires?: readonly string[];
}

export interface ResolvedManifestPlugin extends ResolvedPluginSpec {
	enabled: boolean;
	scope: "global" | "agent";
	provides: string[];
	requires: string[];
}

export interface ResolvedManifestV1 {
	schemaVersion: 1;
	profileId: string;
	plugins: ResolvedManifestPlugin[];
}

export type ResolvedManifestIssueCode =
	| "invalid_manifest"
	| "duplicate_plugin_id"
	| "unknown_plugin"
	| "service_conflict"
	| "missing_service"
	| "non_serializable_config";

export interface ResolvedManifestIssue {
	code: ResolvedManifestIssueCode;
	path: string;
	message: string;
}

export class ResolvedManifestError extends Error {
	readonly issues: readonly ResolvedManifestIssue[];

	constructor(issues: readonly ResolvedManifestIssue[]) {
		super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
		this.name = "ResolvedManifestError";
		this.issues = structuredClone(issues);
	}
}

export function createResolvedManifest(
	profile: ResolvedProfile,
	contracts: ReadonlyMap<string, PluginContract>,
): ResolvedManifestV1 {
	const issues: ResolvedManifestIssue[] = [];
	const plugins = profile.plugins.map((spec, index): ResolvedManifestPlugin => {
		const contract = contracts.get(spec.plugin);
		if (!contract) {
			issues.push({
				code: "unknown_plugin",
				path: `plugins[${index}].plugin`,
				message: `No contract is registered for plugin ${spec.plugin}`,
			});
		}
		if (spec.config !== undefined && !isJsonValue(spec.config, new Set())) {
			issues.push({
				code: "non_serializable_config",
				path: `plugins[${index}].config`,
				message: `Plugin ${spec.id} config must be finite JSON data`,
			});
		}
		return {
			id: spec.id,
			plugin: spec.plugin,
			...(spec.config !== undefined && isJsonValue(spec.config, new Set())
				? { config: structuredClone(spec.config) }
				: {}),
			enabled: spec.enabled ?? true,
			scope: spec.scope ?? "agent",
			provides: [...(contract?.provides ?? [])],
			requires: [...(contract?.requires ?? [])],
		};
	});
	if (issues.length > 0) throw new ResolvedManifestError(issues);
	const manifest: ResolvedManifestV1 = { schemaVersion: 1, profileId: profile.id, plugins };
	assertResolvedManifest(manifest);
	return manifest;
}

export function validateResolvedManifest(value: unknown): ResolvedManifestIssue[] {
	const structural = validateStructure(value);
	if (structural.length > 0) return structural;
	const manifest = value as ResolvedManifestV1;
	const issues: ResolvedManifestIssue[] = [];
	const pluginIds = new Set<string>();
	const providerByService = new Map<string, string>();
	for (const [index, plugin] of manifest.plugins.entries()) {
		if (pluginIds.has(plugin.id)) {
			issues.push({
				code: "duplicate_plugin_id",
				path: `plugins[${index}].id`,
				message: `Duplicate plugin id ${plugin.id}`,
			});
		}
		pluginIds.add(plugin.id);
		if (plugin.config !== undefined && !isJsonValue(plugin.config, new Set())) {
			issues.push({
				code: "non_serializable_config",
				path: `plugins[${index}].config`,
				message: `Plugin ${plugin.id} config must be finite JSON data`,
			});
		}
		if (!plugin.enabled) continue;
		for (const service of plugin.provides) {
			const existing = providerByService.get(service);
			if (existing) {
				issues.push({
					code: "service_conflict",
					path: `plugins[${index}].provides`,
					message: `Service ${service} is provided by both ${existing} and ${plugin.id}`,
				});
			} else {
				providerByService.set(service, plugin.id);
			}
		}
	}
	for (const [index, plugin] of manifest.plugins.entries()) {
		if (!plugin.enabled) continue;
		for (const service of plugin.requires) {
			if (!providerByService.has(service)) {
				issues.push({
					code: "missing_service",
					path: `plugins[${index}].requires`,
					message: `Plugin ${plugin.id} requires missing service ${service}`,
				});
			}
		}
	}
	return issues;
}

export function assertResolvedManifest(value: unknown): asserts value is ResolvedManifestV1 {
	const issues = validateResolvedManifest(value);
	if (issues.length > 0) throw new ResolvedManifestError(issues);
}

export function serializeResolvedManifest(manifest: ResolvedManifestV1): string {
	assertResolvedManifest(manifest);
	return `${JSON.stringify(sortJson(manifest), undefined, 2)}\n`;
}

function validateStructure(value: unknown): ResolvedManifestIssue[] {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		!isNonEmptyString(value.profileId) ||
		!Array.isArray(value.plugins)
	) {
		return [{ code: "invalid_manifest", path: "$", message: "Expected a version 1 resolved manifest" }];
	}
	for (const [index, plugin] of value.plugins.entries()) {
		if (
			!isRecord(plugin) ||
			!isNonEmptyString(plugin.id) ||
			!isNonEmptyString(plugin.plugin) ||
			typeof plugin.enabled !== "boolean" ||
			(plugin.scope !== "global" && plugin.scope !== "agent") ||
			!isStringArray(plugin.provides) ||
			!isStringArray(plugin.requires)
		) {
			return [
				{
					code: "invalid_manifest",
					path: `plugins[${index}]`,
					message: "Plugin entries require id, plugin, enabled, scope, provides, and requires",
				},
			];
		}
	}
	return [];
}

function isJsonValue(value: unknown, ancestors: Set<object>): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object") return false;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	const valid = Array.isArray(value)
		? value.every((item) => isJsonValue(item, ancestors))
		: Object.values(value).every((item) => isJsonValue(item, ancestors));
	ancestors.delete(value);
	return valid;
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, sortJson(value[key])]),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isNonEmptyString);
}
