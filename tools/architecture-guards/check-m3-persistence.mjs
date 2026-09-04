import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const requiredFiles = [
	"packages/agent/src/runtime/journal/jsonl-journal.ts",
	"packages/agent/src/runtime/journal/blob-store.ts",
	"packages/agent/src/runtime/journal/recovery.ts",
	"packages/agent/src/runtime/journal/thread-index.ts",
	"packages/agent/test/runtime/jsonl-journal.test.ts",
	"packages/agent/test/runtime/fault-recovery.test.ts",
	"packages/agent/test/runtime/blob-store.test.ts",
	"packages/agent/test/runtime/thread-index.test.ts",
];

const failures = [];

for (const relativePath of requiredFiles) {
	try {
		const content = await readFile(resolve(repositoryRoot, relativePath), "utf8");
		if (content.trim().length === 0) {
			failures.push(`${relativePath}: file is empty`);
		}

		// Architecture Rule: JSONL Journal Store must detect mid-log corruption and fail closed
		if (relativePath === "packages/agent/src/runtime/journal/jsonl-journal.ts") {
			if (!content.includes("Mid-log corruption detected")) {
				failures.push(`${relativePath}: must fail closed on mid-log corruption`);
			}
			if (!content.includes(".sync()")) {
				failures.push(`${relativePath}: must perform physical fsync barrier in flush()`);
			}
		}

		// Architecture Rule: Recovery must settle in-flight attempts as outcome_unknown
		if (relativePath === "packages/agent/src/runtime/journal/recovery.ts") {
			if (!content.includes("outcome_unknown")) {
				failures.push(`${relativePath}: must settle in-flight uncompleted attempts as outcome_unknown`);
			}
		}
	} catch (err) {
		failures.push(`${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

if (failures.length > 0) {
	console.error("M3 Persistence Architecture Violations:\n" + failures.join("\n"));
	process.exitCode = 1;
} else {
	console.log(`M3 architecture persistence OK (${requiredFiles.length} verified artifacts)`);
}
