export interface ResolvedPluginSpec {
	id: string;
	plugin: string;
	config?: unknown;
	enabled?: boolean;
	scope?: "global" | "agent";
}

export interface Bundle {
	id: string;
	plugins: readonly ResolvedPluginSpec[];
}

export type ProfilePatch =
	| { operation: "insert"; spec: ResolvedPluginSpec; after?: string }
	| { operation: "disable"; id: string }
	| { operation: "mergeConfig"; id: string; config: Record<string, unknown> }
	| { operation: "replaceConfig"; id: string; config: unknown };

export interface Profile {
	id: string;
	bundles: readonly string[];
	patches?: readonly ProfilePatch[];
}

export interface ResolvedProfile {
	id: string;
	plugins: ResolvedPluginSpec[];
}

export function composeProfile(profile: Profile, bundles: ReadonlyMap<string, Bundle>): ResolvedProfile {
	const plugins: ResolvedPluginSpec[] = [];
	const ids = new Set<string>();
	for (const bundleId of profile.bundles) {
		const bundle = bundles.get(bundleId);
		if (!bundle) throw new Error(`Unknown bundle: ${bundleId}`);
		for (const spec of bundle.plugins) {
			if (ids.has(spec.id)) throw new Error(`Duplicate plugin spec id: ${spec.id}`);
			ids.add(spec.id);
			plugins.push(structuredClone(spec));
		}
	}
	for (const patch of profile.patches ?? []) applyPatch(plugins, ids, patch);
	return { id: profile.id, plugins };
}

function applyPatch(plugins: ResolvedPluginSpec[], ids: Set<string>, patch: ProfilePatch): void {
	if (patch.operation === "insert") {
		if (ids.has(patch.spec.id)) throw new Error(`Duplicate plugin spec id: ${patch.spec.id}`);
		const index =
			patch.after === undefined ? plugins.length : plugins.findIndex((spec) => spec.id === patch.after) + 1;
		if (index === 0) throw new Error(`Patch target not found: ${patch.after}`);
		plugins.splice(index, 0, structuredClone(patch.spec));
		ids.add(patch.spec.id);
		return;
	}
	const spec = plugins.find((candidate) => candidate.id === patch.id);
	if (!spec) throw new Error(`Patch target not found: ${patch.id}`);
	if (patch.operation === "disable") spec.enabled = false;
	if (patch.operation === "replaceConfig") spec.config = structuredClone(patch.config);
	if (patch.operation === "mergeConfig") {
		if (spec.config !== undefined && (!isRecord(spec.config) || Array.isArray(spec.config))) {
			throw new Error(`Cannot merge non-object config for ${patch.id}`);
		}
		spec.config = { ...(spec.config ?? {}), ...structuredClone(patch.config) };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
