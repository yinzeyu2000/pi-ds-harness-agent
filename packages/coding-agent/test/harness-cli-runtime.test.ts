import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { createInteractiveHarnessApproval, formatHarnessApprovalPrompt } from "../src/cli/harness-approval.ts";
import {
	loadHarnessLegacyExtensions,
	resolveHarnessSessionId,
	resolveHarnessToolNames,
	validateHarnessCliRuntimeArgs,
} from "../src/cli/harness-runtime.ts";
import { loadProjectContextFiles } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("Harness CLI runtime adapter", () => {
	it("loads only trusted global context when project context is not trusted", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ds-harness-trust-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		try {
			await mkdir(cwd, { recursive: true });
			await mkdir(agentDir, { recursive: true });
			await writeFile(join(agentDir, "AGENTS.md"), "global context", "utf8");
			await writeFile(join(cwd, "AGENTS.md"), "project context", "utf8");

			const untrusted = loadProjectContextFiles({ cwd, agentDir, includeProject: false });
			const trusted = loadProjectContextFiles({ cwd, agentDir, includeProject: true });

			expect(untrusted.map((file) => file.content)).toEqual(["global context"]);
			expect(trusted.map((file) => file.content)).toEqual(["global context", "project context"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("imports explicit Extension factories without activating them outside Plugin Scope", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-harness-cli-extension-"));
		try {
			const extensionPath = join(cwd, "sample-extension.ts");
			await writeFile(
				extensionPath,
				"export default function extension(pi) { pi.registerCommand('sample', { handler: async () => {} }); }\n",
				"utf8",
			);

			const specifications = await loadHarnessLegacyExtensions([extensionPath], cwd);

			expect(specifications).toHaveLength(1);
			expect(specifications[0]?.extensionPath).toBe(extensionPath);
			expect(specifications[0]?.factory).toEqual(expect.any(Function));
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("adapts an interactive confirmation into an allow-or-deny approval decision", async () => {
		const prompts: string[] = [];
		const approval = createInteractiveHarnessApproval((message) => {
			prompts.push(message);
			return true;
		});
		const request = { id: "call-1", name: "write", args: { path: "result.txt", content: "safe" } };

		expect(await approval.requestApproval(request)).toEqual({ decision: "allow" });
		expect(prompts).toEqual([formatHarnessApprovalPrompt(request)]);
		expect(await createInteractiveHarnessApproval(() => false).requestApproval(request)).toEqual({
			decision: "deny",
			reason: "User denied tool write",
		});
		const controller = new AbortController();
		controller.abort();
		expect(await approval.requestApproval(request, controller.signal)).toEqual({
			decision: "deny",
			reason: "Tool approval was aborted",
		});
	});

	it("resolves tool allowlists and rejects unsupported compatibility flags", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-harness-cli-tools-"));
		try {
			const settings = SettingsManager.create(cwd, join(cwd, ".pi"));
			const parsed = parseArgs(["--tools", "read,grep", "--exclude-tools", "grep"]);
			expect(resolveHarnessToolNames(parsed, settings)).toEqual(["read"]);
			expect(() =>
				validateHarnessCliRuntimeArgs({
					parsed: parseArgs(["--name", "named", "--extension-flag=value"]),
					mode: "text",
					cwd,
					agentDir: join(cwd, ".pi"),
					sessionsRoot: join(cwd, ".sessions"),
					settingsManager: settings,
					offline: true,
				}),
			).not.toThrow();
			expect(() =>
				validateHarnessCliRuntimeArgs({
					parsed: parseArgs(["--models", "faux/*:high"]),
					mode: "interactive",
					cwd,
					agentDir: join(cwd, ".pi"),
					sessionsRoot: join(cwd, ".sessions"),
					settingsManager: settings,
					offline: true,
				}),
			).not.toThrow();
			expect(() =>
				validateHarnessCliRuntimeArgs({
					parsed: parseArgs(["--prompt-template", "./review.md", "--no-prompt-templates"]),
					mode: "text",
					cwd,
					agentDir: join(cwd, ".pi"),
					sessionsRoot: join(cwd, ".sessions"),
					settingsManager: settings,
					offline: true,
				}),
			).not.toThrow();
			expect(() =>
				validateHarnessCliRuntimeArgs({
					parsed: parseArgs(["--harness-runtime", "--use-theme", "dark"]),
					mode: "interactive",
					cwd,
					agentDir: join(cwd, ".pi"),
					sessionsRoot: join(cwd, ".sessions"),
					settingsManager: settings,
					offline: true,
				}),
			).not.toThrow();
			expect(() =>
				validateHarnessCliRuntimeArgs({
					parsed: parseArgs(["--harness-runtime", "--mode", "rpc"]),
					mode: "rpc",
					cwd,
					agentDir: join(cwd, ".pi"),
					sessionsRoot: join(cwd, ".sessions"),
					settingsManager: settings,
					offline: true,
				}),
			).not.toThrow();
			expect(() =>
				validateHarnessCliRuntimeArgs({
					parsed: parseArgs(["--fork", "entry-id"]),
					mode: "text",
					cwd,
					agentDir: join(cwd, ".pi"),
					sessionsRoot: join(cwd, ".sessions"),
					settingsManager: settings,
					offline: true,
				}),
			).not.toThrow();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("continues the most recently modified canonical project session", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-harness-cli-session-"));
		const sessionsRoot = join(cwd, ".sessions");
		try {
			const env = new NodeExecutionEnv({ cwd });
			const repo = new JsonlSessionRepo({ fs: env, sessionsRoot });
			await repo.create({ cwd, id: "older" });
			await repo.create({ cwd, id: "newer" });
			const result = await resolveHarnessSessionId(parseArgs(["--continue"]), cwd, sessionsRoot);
			expect(result).toBe("newer");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("resolves an explicit canonical session path or id", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-harness-cli-explicit-session-"));
		const sessionsRoot = join(cwd, ".sessions");
		try {
			const env = new NodeExecutionEnv({ cwd });
			const repo = new JsonlSessionRepo({ fs: env, sessionsRoot });
			const session = await repo.create({ cwd, id: "explicit" });
			const metadata = await session.getMetadata();

			expect(await resolveHarnessSessionId(parseArgs(["--session", metadata.path]), cwd, sessionsRoot)).toBe(
				"explicit",
			);
			expect(await resolveHarnessSessionId(parseArgs(["--session", "explicit"]), cwd, sessionsRoot)).toBe(
				"explicit",
			);
			await expect(
				resolveHarnessSessionId(parseArgs(["--session", "missing.jsonl"]), cwd, sessionsRoot),
			).rejects.toThrow("Harness session was not found");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("forks a canonical source Session into the startup cwd", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-harness-cli-fork-"));
		const sourceCwd = await mkdtemp(join(tmpdir(), "pi-ds-harness-cli-fork-source-"));
		const sessionsRoot = join(cwd, ".sessions");
		try {
			const env = new NodeExecutionEnv({ cwd });
			const repo = new JsonlSessionRepo({ fs: env, sessionsRoot });
			const source = await repo.create({ cwd: sourceCwd, id: "source" });
			await source.appendMessage({ role: "user", content: "fork me", timestamp: Date.now() });
			await source.flush();
			const sourcePath = (await source.getMetadata()).path;

			expect(
				await resolveHarnessSessionId(
					parseArgs(["--fork", sourcePath, "--session-id", "forked"]),
					cwd,
					sessionsRoot,
				),
			).toBe("forked");
			const forkedMetadata = (await repo.list({ cwd })).find(({ id }) => id === "forked");
			expect(forkedMetadata).toMatchObject({ id: "forked", cwd, parentSessionId: "source" });
			const forked = await repo.open(forkedMetadata!);
			expect(await forked.findEntries({ type: "message" })).toHaveLength(1);
		} finally {
			await rm(cwd, { recursive: true, force: true });
			await rm(sourceCwd, { recursive: true, force: true });
		}
	});
});
