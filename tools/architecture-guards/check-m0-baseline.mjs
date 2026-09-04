import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const requiredFiles = [
	"EXECUTION_PLAN.md",
	"M0_STATUS.md",
	"docs/source-port-ledger.md",
	"docs/repository-map.md",
	"docs/threat-model.md",
	"docs/release-gates.md",
	...[
		"0001-fixed-source-baselines.md",
		"0002-domain-language-and-identities.md",
		"0003-single-thread-runtime.md",
		"0004-single-canonical-journal.md",
		"0005-durability-and-publication-boundaries.md",
		"0007-thread-lifecycle-and-runtime-generation.md",
		"0008-controller-fencing-and-command-admission.md",
		"0009-model-tool-attempts-and-dispatch-barriers.md",
		"0011-sandbox-platform-strategy.md",
		"0012-security-microkernel-and-tcb.md",
	].map((name) => `docs/adr/${name}`),
];

const failures = [];
for (const relativePath of requiredFiles) {
	try {
		const content = await readFile(resolve(repositoryRoot, relativePath), "utf8");
		if (content.trim().length === 0) failures.push(`${relativePath}: empty`);
		if (relativePath.startsWith("docs/adr/") && !content.includes("Status: Accepted")) {
			failures.push(`${relativePath}: not accepted`);
		}
	} catch (error) {
		failures.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

if (failures.length > 0) {
	console.error(failures.join("\n"));
	process.exitCode = 1;
} else {
	console.log(`M0 architecture baseline OK (${requiredFiles.length} required artifacts)`);
}
