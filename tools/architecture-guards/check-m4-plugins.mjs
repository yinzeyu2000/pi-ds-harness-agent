import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const requiredFiles = [
	"packages/agent/src/runtime/plugin/scopes.ts",
	"packages/agent/src/runtime/plugin/services.ts",
	"packages/agent/src/runtime/plugin/profile.ts",
	"packages/agent/src/runtime/plugin/extension-adapter.ts",
	"packages/agent/test/runtime/plugin-composition.test.ts",
	"packages/agent/test/runtime/plugin-scopes.test.ts",
	"packages/agent/test/runtime/profile.test.ts",
	"packages/agent/test/runtime/extension-adapter.test.ts",
];

const failures = [];

for (const relativePath of requiredFiles) {
	try {
		const content = await readFile(resolve(repositoryRoot, relativePath), "utf8");
		if (content.trim().length === 0) {
			failures.push(`${relativePath}: file is empty`);
		}

		// Architecture Rule: No Cordis imports in plugin code
		if (content.includes("cordis") || content.includes("@cordisjs")) {
			failures.push(`${relativePath}: forbidden Cordis dependency detected in public plugin module`);
		}

		// Architecture Rule: Scope hierarchy check
		if (relativePath === "packages/agent/src/runtime/plugin/scopes.ts") {
			if (!content.includes("createRuntimeScope") || !content.includes("createThreadScope") || !content.includes("createTurnScope") || !content.includes("createTaskScope")) {
				failures.push(`${relativePath}: missing full 4-tier scope hierarchy (Runtime, Thread, Turn, Task)`);
			}
		}

		// Architecture Rule: Deterministic hash function
		if (relativePath === "packages/agent/src/runtime/plugin/profile.ts") {
			if (!content.includes("computeManifestHash")) {
				failures.push(`${relativePath}: missing computeManifestHash function`);
			}
		}
	} catch (err) {
		failures.push(`${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

if (failures.length > 0) {
	console.error("M4 Plugin Composition Architecture Violations:\n" + failures.join("\n"));
	process.exitCode = 1;
} else {
	console.log(`M4 architecture plugin composition OK (${requiredFiles.length} verified artifacts)`);
}
