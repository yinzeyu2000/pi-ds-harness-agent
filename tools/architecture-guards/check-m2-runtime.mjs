import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const requiredFiles = [
	"packages/agent/src/runtime/journal/memory-journal.ts",
	"packages/agent/src/runtime/journal/projection.ts",
	"packages/agent/src/runtime/thread/mailbox.ts",
	"packages/agent/src/runtime/thread/thread-runtime-impl.ts",
	"packages/agent/src/runtime/runtime-host/lifecycle-coordinator-impl.ts",
	"packages/agent/src/runtime/runtime-host/runtime-host-impl.ts",
	"packages/agent/src/runtime/adapters/fake-model-gateway.ts",
	"packages/agent/src/runtime/adapters/memory-execution-broker.ts",
	"packages/agent/src/runtime/driver/pi-event-translator.ts",
	"packages/agent/src/runtime/driver/pi-agent-driver.ts",
	"packages/agent/src/runtime/client/headless-client.ts",
	"packages/agent/test/runtime/memory-journal.test.ts",
	"packages/agent/test/runtime/active-turn-exclusivity.test.ts",
	"packages/agent/test/runtime/interrupt-terminal-race.test.ts",
	"packages/agent/test/runtime/dual-observers.test.ts",
	"packages/agent/test/runtime/vertical-closed-loop.test.ts",
];

const failures = [];

for (const relativePath of requiredFiles) {
	try {
		const content = await readFile(resolve(repositoryRoot, relativePath), "utf8");
		if (content.trim().length === 0) {
			failures.push(`${relativePath}: file is empty`);
		}

		// Architecture Rule: Memory Execution Broker in M2 must not import real child_process or fs
		if (relativePath === "packages/agent/src/runtime/adapters/memory-execution-broker.ts") {
			if (content.includes("node:child_process") || content.includes("node:fs")) {
				failures.push(`${relativePath}: M2 memory broker must remain pure in-memory and not call child_process/fs`);
			}
		}

		// Architecture Rule: ThreadRuntime must guard against dual active turns
		if (relativePath === "packages/agent/src/runtime/thread/thread-runtime-impl.ts") {
			if (!content.includes("ActiveTurnConflictError") && !content.includes("ACTIVE_TURN_CONFLICT")) {
				failures.push(`${relativePath}: must enforce ActiveTurnConflictError guard`);
			}
		}
	} catch (err) {
		failures.push(`${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

if (failures.length > 0) {
	console.error("M2 Runtime Architecture Violations:\n" + failures.join("\n"));
	process.exitCode = 1;
} else {
	console.log(`M2 architecture runtime OK (${requiredFiles.length} verified artifacts)`);
}
