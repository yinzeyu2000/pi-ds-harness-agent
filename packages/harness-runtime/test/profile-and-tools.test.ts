import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { composeProfile } from "../src/profile.ts";
import { ToolCatalog, ToolCatalogConflictError } from "../src/tool-catalog.ts";
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

	it("requires an explicit replace patch to exchange a plugin owner", () => {
		const bundles = new Map([
			["base", { id: "base", plugins: [{ id: "session-memory", plugin: "session-memory" }] }],
		]);
		const resolved = composeProfile(
			{
				id: "durable",
				bundles: ["base"],
				patches: [
					{
						operation: "replace",
						id: "session-memory",
						spec: { id: "session-jsonl", plugin: "session-jsonl" },
					},
				],
			},
			bundles,
		);
		expect(resolved.plugins).toEqual([{ id: "session-jsonl", plugin: "session-jsonl" }]);
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

	it("runs every stage in a fixed order with the effective request", async () => {
		const stages: string[] = [];
		const result = await executeToolPipeline(
			{ id: "1", name: "write", args: { value: 1 } },
			async (request) => {
				stages.push(`body:${request.args.value}`);
				return request.args.value;
			},
			{
				pre: [
					async (request) => {
						stages.push("pre");
						return { ...request, args: { value: request.args.value + 1 } };
					},
				],
				guards: [
					() => {
						stages.push("guard");
						return { decision: "allow" };
					},
				],
				approval: {
					required: true,
					service: {
						requestApproval(request) {
							stages.push(`approval:${request.args.value}`);
							return { decision: "allow" };
						},
					},
				},
				around: [
					async (_request, next) => {
						stages.push("around:before");
						const value = await next();
						stages.push("around:after");
						return value;
					},
				],
				post: [
					(_request, value) => {
						stages.push("post");
						return value;
					},
				],
				result: [
					(_request, value) => {
						stages.push("result");
						return value;
					},
				],
			},
		);
		expect(result).toEqual({ value: 2, isError: false });
		expect(stages).toEqual([
			"pre",
			"guard",
			"approval:2",
			"around:before",
			"body:2",
			"around:after",
			"post",
			"result",
		]);
	});

	it("fails closed without an approval service and stops before a canceled side effect", async () => {
		const body = vi.fn(async () => "done");
		const denied = await executeToolPipeline({ id: "1", name: "delete", args: {} }, body, {
			approval: { required: true },
		});
		expect(denied).toEqual({
			isError: true,
			error: {
				code: "approval_denied",
				message: "Approval is required but no interactive approval service is available",
			},
		});

		const controller = new AbortController();
		const canceled = await executeToolPipeline(
			{ id: "2", name: "write", args: {} },
			body,
			{
				approval: {
					required: true,
					service: {
						requestApproval() {
							controller.abort();
							return { decision: "allow" };
						},
					},
				},
			},
			controller.signal,
		);
		expect(canceled.error?.code).toBe("aborted");
		expect(body).not.toHaveBeenCalled();
	});

	it.each([
		["pre", { pre: [() => Promise.reject(new Error("pre failed"))] }, "pre_error"],
		["guard", { guards: [() => Promise.reject(new Error("guard failed"))] }, "guard_error"],
		[
			"approval",
			{
				approval: {
					required: true,
					service: { requestApproval: () => Promise.reject(new Error("approval failed")) },
				},
			},
			"approval_error",
		],
		["around", { around: [() => Promise.reject(new Error("around failed"))] }, "middleware_error"],
		["post", { post: [() => Promise.reject(new Error("post failed"))] }, "post_error"],
		["result", { result: [() => Promise.reject(new Error("result failed"))] }, "result_error"],
	] as const)("normalizes a %s stage exception", async (_stage, pipeline, code) => {
		const result = await executeToolPipeline({ id: "1", name: "read", args: {} }, async () => "done", pipeline);
		expect(result.error?.code).toBe(code);
	});

	it("rejects middleware that invokes next more than once", async () => {
		const body = vi.fn(async () => "done");
		const result = await executeToolPipeline({ id: "1", name: "read", args: {} }, body, {
			around: [
				async (_request, next) => {
					await next();
					return next();
				},
			],
		});
		expect(result.error).toMatchObject({ code: "middleware_error" });
		expect(body).toHaveBeenCalledOnce();
	});
});

describe("tool catalog", () => {
	it("is scoped, rejects duplicate names, and unregisters idempotently", () => {
		const tool = { name: "read" } as never;
		const first = new ToolCatalog();
		const second = new ToolCatalog();
		const unregister = first.register({ tool, replay: "safe" });
		expect(first.list()).toEqual([tool]);
		expect(first.replayPolicies()).toEqual({ read: "safe" });
		expect(second.size).toBe(0);
		expect(() => first.register({ tool })).toThrow(ToolCatalogConflictError);
		unregister();
		unregister();
		expect(first.size).toBe(0);
	});

	it("wraps executions in versioned policies and preserves structured failures", async () => {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "done" }], details: {} }));
		const tool: AgentTool = {
			name: "write",
			label: "Write",
			description: "Writes data",
			parameters: Type.Object({}),
			execute,
		};
		const catalog = new ToolCatalog();
		expect(() => catalog.register({ tool, pipeline: {} })).toThrow(/policyVersion/);
		catalog.register({
			tool,
			policyVersion: "write-policy-v1",
			pipeline: { approval: { required: true } },
		});
		expect(catalog.policyVersions()).toEqual({ write: "write-policy-v1" });
		await expect(catalog.get("write")?.execute("call-1", {})).rejects.toMatchObject({
			failure: { code: "approval_denied" },
		});
		expect(execute).not.toHaveBeenCalled();
	});
});
