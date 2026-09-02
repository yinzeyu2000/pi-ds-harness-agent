import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(root: string): string[] {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
	});
}

describe("architecture boundaries", () => {
	it("keeps Pi Agent Core independent from the composition runtime", () => {
		for (const file of sourceFiles(join(import.meta.dirname, "../../agent/src"))) {
			expect(readFileSync(file, "utf8"), file).not.toContain("@pi-ds/");
		}
	});

	it("keeps the harness core independent from products, storage providers, and Node runtime APIs", () => {
		const forbidden = [
			"@earendil-works/pi-coding-agent",
			"@earendil-works/pi-tui",
			"@earendil-works/pi-session-backend-sqlite-node",
			'from "node:',
		];
		for (const file of sourceFiles(join(import.meta.dirname, "../src"))) {
			const source = readFileSync(file, "utf8");
			for (const dependency of forbidden) expect(source, file).not.toContain(dependency);
		}
	});
});
