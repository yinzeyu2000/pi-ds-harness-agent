import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const requiredFiles = [
	"packages/protocol/src/v2/branded-ids.ts",
	"packages/protocol/src/v2/cursor.ts",
	"packages/protocol/src/v2/capabilities.ts",
	"packages/protocol/src/v2/controller.ts",
	"packages/protocol/src/v2/dedupe.ts",
	"packages/protocol/src/v2/wire-types.ts",
	"packages/protocol/src/v2/schemas.ts",
	"packages/protocol/src/v2/index.ts",
	"packages/agent/src/runtime/types/errors.ts",
	"packages/agent/src/runtime/types/journal.ts",
	"packages/agent/src/runtime/types/state-machines.ts",
	"packages/agent/src/runtime/types/runtime-host.ts",
	"packages/agent/src/runtime/types/thread-runtime.ts",
	"packages/agent/src/runtime/types/agent-driver.ts",
	"packages/agent/src/runtime/types/model-gateway.ts",
	"packages/agent/src/runtime/types/execution-broker.ts",
	"packages/agent/src/runtime/types/providers.ts",
	"packages/agent/src/runtime/state-machines/transitions.ts",
	"packages/agent/src/runtime/state-machines/models.ts",
	"packages/agent/src/runtime/plugin/tokens.ts",
	"packages/agent/src/runtime/plugin/manifest.ts",
	"packages/agent/src/runtime/plugin/context.ts",
	"packages/agent/src/runtime/plugin/service-scope.ts",
	"packages/agent/src/runtime/plugin/effect-scope.ts",
	"packages/agent/src/runtime/plugin/plugin-host.ts",
	"docs/spikes/cordis-vs-self-host.md",
];

const failures = [];

for (const relativePath of requiredFiles) {
	try {
		const content = await readFile(resolve(repositoryRoot, relativePath), "utf8");
		if (content.trim().length === 0) {
			failures.push(`${relativePath}: empty`);
		}

		// Architecture Rule: Public Plugin SDK must NEVER leak cordis
		if (relativePath.startsWith("packages/agent/src/runtime/plugin/") && !relativePath.includes("cordis-spike")) {
			if (content.includes('from "cordis"') || content.includes("from '@deepseek-ai/cordis'")) {
				failures.push(`${relativePath}: contains forbidden direct Cordis import in public SDK`);
			}
		}

		// Architecture Rule: State machine core must NOT depend on Node native fs/child_process
		if (relativePath.startsWith("packages/agent/src/runtime/state-machines/")) {
			if (content.includes("node:fs") || content.includes("node:child_process")) {
				failures.push(`${relativePath}: state machines must be pure and not import node native fs/child_process`);
			}
		}
	} catch (err) {
		failures.push(`${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

if (failures.length > 0) {
	console.error("M1 Contract Architecture Violations:\n" + failures.join("\n"));
	process.exitCode = 1;
} else {
	console.log(`M1 architecture contracts OK (${requiredFiles.length} verified artifacts)`);
}
