import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCodingManifest } from "../src/coding-profile.ts";
import { resolveMinimalManifest } from "../src/minimal-runtime.ts";
import type { HarnessPlugin } from "../src/plugin-sdk.ts";
import {
	createResolvedManifest,
	ResolvedManifestError,
	serializeResolvedManifest,
	validateResolvedManifest,
} from "../src/resolved-manifest.ts";
import { createServiceToken } from "../src/services.ts";
import { inspectPluginConformance } from "../src/testing/plugin-conformance.ts";
import { EXAMPLE_GREETING, exampleThirdPartyPlugin } from "./fixtures/third-party-plugin.ts";

describe("resolved manifest", () => {
	it("keeps the checked-in minimal manifest aligned with runtime contracts", () => {
		const checkedIn: unknown = JSON.parse(
			readFileSync(join(import.meta.dirname, "../profiles/minimal.resolved.json"), "utf8"),
		);
		expect(checkedIn).toEqual(resolveMinimalManifest());
	});

	it("keeps the checked-in coding manifest aligned and replaces memory ownership with JSONL", () => {
		const checkedIn: unknown = JSON.parse(
			readFileSync(join(import.meta.dirname, "../profiles/coding.resolved.json"), "utf8"),
		);
		const manifest = resolveCodingManifest();
		expect(checkedIn).toEqual(manifest);
		expect(validateResolvedManifest(manifest)).toEqual([]);
		expect(manifest.plugins.some((plugin) => plugin.id === "session-memory")).toBe(false);
		expect(
			manifest.plugins.filter((plugin) => plugin.enabled && plugin.provides.includes("pi-ds.session")),
		).toHaveLength(1);
	});

	it("resolves plugin contracts into deterministic validated output", () => {
		const profile = {
			id: "example",
			plugins: [
				{ id: "provider", plugin: "provider", config: { z: 1, a: true } },
				{ id: "consumer", plugin: "consumer" },
			],
		};
		const contracts = new Map([
			["provider", { plugin: "provider", provides: ["value"] }],
			["consumer", { plugin: "consumer", requires: ["value"] }],
		]);
		const manifest = createResolvedManifest(profile, contracts);
		expect(validateResolvedManifest(manifest)).toEqual([]);
		expect(serializeResolvedManifest(manifest)).toBe(serializeResolvedManifest(manifest));
		expect(serializeResolvedManifest(manifest)).toContain('"a": true');
		expect(serializeResolvedManifest(manifest).indexOf('"a": true')).toBeLessThan(
			serializeResolvedManifest(manifest).indexOf('"z": 1'),
		);
	});

	it("reports duplicate providers, missing requirements, and unknown contracts", () => {
		const invalid = {
			schemaVersion: 1,
			profileId: "broken",
			plugins: [
				{
					id: "first",
					plugin: "first",
					enabled: true,
					scope: "agent",
					provides: ["shared"],
					requires: ["missing"],
				},
				{
					id: "second",
					plugin: "second",
					enabled: true,
					scope: "agent",
					provides: ["shared"],
					requires: [],
				},
			],
		};
		expect(validateResolvedManifest(invalid).map((issue) => issue.code)).toEqual([
			"service_conflict",
			"missing_service",
		]);
		expect(() => createResolvedManifest({ id: "x", plugins: [{ id: "x", plugin: "missing" }] }, new Map())).toThrow(
			ResolvedManifestError,
		);
	});
});

describe("public plugin SDK and conformance", () => {
	it("loads a third-party plugin through only the public plugin-sdk entrypoint", async () => {
		const source = readFileSync(join(import.meta.dirname, "fixtures/third-party-plugin.ts"), "utf8");
		expect(source).toContain('from "@pi-ds/harness-runtime/plugin-sdk"');
		expect(source).not.toContain("../src/");
		const report = await inspectPluginConformance({
			plugin: exampleThirdPartyPlugin,
			config: { greeting: "hello" },
		});
		expect(report).toEqual({ pluginId: "example-third-party", ok: true, issues: [] });
	});

	it("reports a declared service that activation did not provide", async () => {
		const MISSING = createServiceToken<string>("missing");
		const plugin: HarnessPlugin = {
			manifest: { id: "incomplete", version: "1", provides: [MISSING] },
			activate() {},
		};
		const report = await inspectPluginConformance({ plugin, config: undefined });
		expect(report.ok).toBe(false);
		expect(report.issues).toMatchObject([{ code: "missing_declared_service" }]);
		expect(EXAMPLE_GREETING.id).toBe("example.greeting");
	});
});
