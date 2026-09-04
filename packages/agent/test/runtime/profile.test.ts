import { describe, expect, test } from "vitest";
import { type Bundle, composeProfile, computeManifestHash, type Profile } from "../../src/runtime/index.ts";

describe("Profiles, Bundles, Patches, and Deterministic Manifest Hashing", () => {
	const bundle1: Bundle = {
		id: "b1",
		plugins: [
			{ id: "p1", plugin: "plugin-core", enabled: true, scope: "runtime" },
			{ id: "p2", plugin: "plugin-models", enabled: true, scope: "runtime" },
		],
	};

	const bundle2: Bundle = {
		id: "b2",
		plugins: [{ id: "p3", plugin: "plugin-tools", enabled: true, scope: "thread" }],
	};

	const bundlesMap = new Map<string, Bundle>([
		["b1", bundle1],
		["b2", bundle2],
	]);

	test("composes bundles and patches correctly", () => {
		const profile: Profile = {
			id: "custom-profile",
			bundles: ["b1", "b2"],
			patches: [
				{
					operation: "insert",
					spec: { id: "p-inserted", plugin: "plugin-extra", scope: "turn" },
					after: "p2",
				},
				{
					operation: "disable",
					id: "p3",
				},
				{
					operation: "mergeConfig",
					id: "p1",
					config: { timeoutMs: 5000 },
				},
			],
		};

		const resolved = composeProfile(profile, bundlesMap);

		expect(resolved.plugins.length).toBe(4);
		expect(resolved.plugins.map((p) => p.id)).toEqual(["p1", "p2", "p-inserted", "p3"]);
		expect(resolved.plugins[3]!.enabled).toBe(false);
		expect(resolved.plugins[0]!.config).toEqual({ timeoutMs: 5000 });
	});

	test("identical composition produces identical deterministic manifest hash", () => {
		const profileA: Profile = {
			id: "prof",
			bundles: ["b1", "b2"],
		};
		const profileB: Profile = {
			id: "prof",
			bundles: ["b1", "b2"],
		};

		const resolvedA = composeProfile(profileA, bundlesMap);
		const resolvedB = composeProfile(profileB, bundlesMap);

		const hashA = computeManifestHash(resolvedA);
		const hashB = computeManifestHash(resolvedB);

		expect(hashA).toBe(hashB);
		expect(hashA.startsWith("mh_")).toBe(true);

		// Modified composition must produce a different hash
		const profileC: Profile = {
			id: "prof",
			bundles: ["b1"],
		};
		const resolvedC = composeProfile(profileC, bundlesMap);
		const hashC = computeManifestHash(resolvedC);

		expect(hashC).not.toBe(hashA);
	});
});
