import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const requiredFiles = [
	"packages/agent/src/runtime/process/output-buffer.ts",
	"packages/agent/src/runtime/process/process-registry.ts",
	"packages/agent/src/runtime/process/process-supervisor-impl.ts",
	"packages/agent/src/runtime/adapters/execution-broker-impl.ts",
	"packages/agent/test/runtime/output-buffer.test.ts",
	"packages/agent/test/runtime/process-supervisor.test.ts",
	"packages/agent/test/runtime/execution-broker.test.ts",
];

const failures = [];

for (const relativePath of requiredFiles) {
	try {
		const content = await readFile(resolve(repositoryRoot, relativePath), "utf8");
		if (content.trim().length === 0) {
			failures.push(`${relativePath}: file is empty`);
		}

		// Architecture Rule: output-buffer and process-registry must be browser-safe (no node:child_process, no node:fs)
		if (
			relativePath === "packages/agent/src/runtime/process/output-buffer.ts" ||
			relativePath === "packages/agent/src/runtime/process/process-registry.ts"
		) {
			if (content.includes("node:child_process") || content.includes("node:fs")) {
				failures.push(`${relativePath}: browser-safe module must not import node:child_process or node:fs`);
			}
		}

		// Architecture Rule: ExecutionBrokerImpl must call onDispatchIntent before starting execution
		if (relativePath === "packages/agent/src/runtime/adapters/execution-broker-impl.ts") {
			if (!content.includes("onDispatchIntent")) {
				failures.push(`${relativePath}: must enforce onDispatchIntent write-before-execute barrier`);
			}
		}

		// Architecture Rule: ProcessSupervisorImpl must implement termination protocol
		if (relativePath === "packages/agent/src/runtime/process/process-supervisor-impl.ts") {
			if (!content.includes("SIGTERM") || !content.includes("SIGKILL")) {
				failures.push(`${relativePath}: must implement TERM -> KILL termination protocol`);
			}
		}
	} catch (err) {
		failures.push(`${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

if (failures.length > 0) {
	console.error("M5 Process Architecture Violations:\n" + failures.join("\n"));
	process.exitCode = 1;
} else {
	console.log(`M5 architecture process runtime OK (${requiredFiles.length} verified artifacts)`);
}
