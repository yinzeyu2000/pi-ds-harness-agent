import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>();
	return { ...actual, spawnSync: spawnSyncMock };
});

import { killProcessTree } from "../../../src/utils/shell.ts";

function withWindowsPlatform(test: () => void): void {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	try {
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		test();
	} finally {
		if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
	}
}

afterEach(() => {
	spawnSyncMock.mockReset();
});

describe("issue #6596 taskkill spawn failures", () => {
	it("uses System32 taskkill and tolerates a synchronous spawn error", () => {
		const previousSystemRoot = process.env.SystemRoot;
		process.env.SystemRoot = "C:\\CustomWindows";
		spawnSyncMock.mockImplementation(() => {
			throw new Error("spawn taskkill ENOENT");
		});

		try {
			withWindowsPlatform(() => {
				killProcessTree(1234);
			});
		} finally {
			if (previousSystemRoot === undefined) delete process.env.SystemRoot;
			else process.env.SystemRoot = previousSystemRoot;
		}

		expect(spawnSyncMock).toHaveBeenCalledWith(
			join("C:\\CustomWindows", "System32", "taskkill.exe"),
			["/F", "/T", "/PID", "1234"],
			{ stdio: "ignore", timeout: 5000, windowsHide: true },
		);
	});
});
