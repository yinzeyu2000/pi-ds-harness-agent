export interface ResolvedPluginSpec {
	readonly id: string;
	readonly plugin: string;
	readonly config?: unknown;
	readonly enabled?: boolean;
	readonly scope?: "runtime" | "thread" | "turn";
}

export interface Bundle {
	readonly id: string;
	readonly plugins: readonly ResolvedPluginSpec[];
}

export type ProfilePatch =
	| { readonly operation: "insert"; readonly spec: ResolvedPluginSpec; readonly after?: string }
	| { readonly operation: "replace"; readonly id: string; readonly spec: ResolvedPluginSpec }
	| { readonly operation: "disable"; readonly id: string }
	| { readonly operation: "mergeConfig"; readonly id: string; readonly config: Record<string, unknown> }
	| { readonly operation: "replaceConfig"; readonly id: string; readonly config: unknown };

export interface Profile {
	readonly id: string;
	readonly bundles: readonly string[];
	readonly patches?: readonly ProfilePatch[];
}

export interface ResolvedProfile {
	readonly id: string;
	readonly plugins: readonly ResolvedPluginSpec[];
}

export function composeProfile(profile: Profile, bundles: ReadonlyMap<string, Bundle>): ResolvedProfile {
	const plugins: ResolvedPluginSpec[] = [];
	const ids = new Set<string>();

	for (const bundleId of profile.bundles) {
		const bundle = bundles.get(bundleId);
		if (!bundle) {
			throw new Error(`Unknown bundle: ${bundleId}`);
		}
		for (const spec of bundle.plugins) {
			if (ids.has(spec.id)) {
				throw new Error(`Duplicate plugin spec id: ${spec.id}`);
			}
			ids.add(spec.id);
			plugins.push({ ...spec });
		}
	}

	for (const patch of profile.patches ?? []) {
		applyPatch(plugins, ids, patch);
	}

	return {
		id: profile.id,
		plugins,
	};
}

function applyPatch(plugins: ResolvedPluginSpec[], ids: Set<string>, patch: ProfilePatch): void {
	if (patch.operation === "insert") {
		if (ids.has(patch.spec.id)) {
			throw new Error(`Duplicate plugin spec id in insert patch: ${patch.spec.id}`);
		}
		const index =
			patch.after === undefined ? plugins.length : plugins.findIndex((spec) => spec.id === patch.after) + 1;
		if (index === 0) {
			throw new Error(`Patch target not found: ${patch.after}`);
		}
		plugins.splice(index, 0, { ...patch.spec });
		ids.add(patch.spec.id);
		return;
	}

	if (patch.operation === "replace") {
		const index = plugins.findIndex((candidate) => candidate.id === patch.id);
		if (index === -1) {
			throw new Error(`Patch target not found: ${patch.id}`);
		}
		plugins[index] = { ...patch.spec };
		return;
	}

	if (patch.operation === "disable") {
		const index = plugins.findIndex((candidate) => candidate.id === patch.id);
		if (index === -1) {
			throw new Error(`Patch target not found: ${patch.id}`);
		}
		plugins[index] = { ...plugins[index]!, enabled: false };
		return;
	}

	if (patch.operation === "mergeConfig") {
		const index = plugins.findIndex((candidate) => candidate.id === patch.id);
		if (index === -1) {
			throw new Error(`Patch target not found: ${patch.id}`);
		}
		const currentConfig =
			typeof plugins[index]!.config === "object" && plugins[index]!.config !== null
				? (plugins[index]!.config as Record<string, unknown>)
				: {};
		plugins[index] = {
			...plugins[index]!,
			config: { ...currentConfig, ...patch.config },
		};
		return;
	}

	if (patch.operation === "replaceConfig") {
		const index = plugins.findIndex((candidate) => candidate.id === patch.id);
		if (index === -1) {
			throw new Error(`Patch target not found: ${patch.id}`);
		}
		plugins[index] = {
			...plugins[index]!,
			config: patch.config,
		};
		return;
	}
}

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

export function computeManifestHash(profile: ResolvedProfile): string {
	const canonical = JSON.stringify({
		id: profile.id,
		plugins: profile.plugins.map((p) => ({
			id: p.id,
			plugin: p.plugin,
			enabled: p.enabled ?? true,
			scope: p.scope ?? "runtime",
			config: p.config ?? null,
		})),
	});

	let hash = FNV_OFFSET_BASIS;
	for (let i = 0; i < canonical.length; i++) {
		hash ^= BigInt(canonical.charCodeAt(i));
		hash = (hash * FNV_PRIME) & 0xffffffffffffffffn;
	}

	return `mh_${hash.toString(16).padStart(16, "0")}`;
}

export const MINIMAL_PROFILE: Profile = Object.freeze({
	id: "minimal",
	bundles: ["bundle:minimal-runtime", "bundle:minimal-tools"],
});

export const TEST_PROFILE: Profile = Object.freeze({
	id: "test",
	bundles: ["bundle:test-fakes"],
});

export const CODING_PROFILE: Profile = Object.freeze({
	id: "coding",
	bundles: ["bundle:minimal-runtime", "bundle:coding-tools", "bundle:sandbox"],
});
