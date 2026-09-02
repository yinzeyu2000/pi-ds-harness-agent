import { describe, expect, it, vi } from "vitest";
import { composeProfile } from "../src/profile.ts";
import { executeToolPipeline } from "../src/tool-pipeline.ts";

describe("profile composition", () => {
	it("produces deterministic manifests with explicit patches", () => {
		const bundles = new Map([
			["base", { id: "base", plugins: [{ id: "model", plugin: "pi-ai", config: { model: "a" } }] }],
		]);
		const profile = {
			id: "minimal",
			bundles: ["base"],
			patches: [
				{ operation: "mergeConfig" as const, id: "model", config: { temperature: 0 } },
				{ operation: "insert" as const, spec: { id: "driver", plugin: "pi-agent-driver" }, after: "model" },
			],
		};
		expect(composeProfile(profile, bundles)).toEqual(composeProfile(profile, bundles));
		expect(composeProfile(profile, bundles).plugins).toEqual([
			{ id: "model", plugin: "pi-ai", config: { model: "a", temperature: 0 } },
			{ id: "driver", plugin: "pi-agent-driver" },
		]);
	});
});

describe("tool pipeline", () => {
	it("never executes a denied tool and normalizes thrown errors", async () => {
		const body = vi.fn(async () => "done");
		const denied = await executeToolPipeline({ id: "1", name: "write", args: {} }, body, {
			guards: [() => ({ decision: "deny", reason: "read only" })],
		});
		expect(denied).toEqual({ isError: true, error: { code: "denied", message: "read only" } });
		expect(body).not.toHaveBeenCalled();
		const failed = await executeToolPipeline({ id: "2", name: "read", args: {} }, async () => {
			throw new Error("broken");
		});
		expect(failed).toEqual({ isError: true, error: { code: "tool_error", message: "broken" } });
	});
});
