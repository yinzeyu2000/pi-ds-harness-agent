import { describe, expect, test } from "vitest";
import { DefaultDenySandboxProvider, SandboxUnsupportedError } from "../../src/runtime/index.ts";

describe("Sandbox Unsupported Default-Deny Contracts", () => {
	test("unsupported sandbox provider defaults to deny on evaluation", async () => {
		const provider = new DefaultDenySandboxProvider();
		expect(provider.isSupported).toBe(false);
		expect(provider.platform).toBe("unsupported");

		await expect(
			provider.evaluate({
				allowWorkspaceOnly: true,
				allowNetwork: false,
			}),
		).rejects.toThrow(SandboxUnsupportedError);
	});

	test("unsupported sandbox provider rejects wrapCommand", async () => {
		const provider = new DefaultDenySandboxProvider();

		await expect(
			provider.wrapCommand("rm", ["-rf", "/"], {
				allowWorkspaceOnly: true,
				allowNetwork: false,
			}),
		).rejects.toThrow(SandboxUnsupportedError);
	});
});
