import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateResolvedManifest } from "../src/resolved-manifest.ts";

const manifestPaths = process.argv.slice(2);
if (manifestPaths.length === 0) {
	console.error("Usage: check-resolved-manifest <manifest.json> [...manifest.json]");
	process.exitCode = 2;
} else {
	for (const manifestPath of manifestPaths) {
		try {
			const absolutePath = resolve(manifestPath);
			const manifest: unknown = JSON.parse(await readFile(absolutePath, "utf8"));
			const issues = validateResolvedManifest(manifest);
			if (issues.length > 0) {
				for (const issue of issues) console.error(`${absolutePath} ${issue.code} ${issue.path}: ${issue.message}`);
				process.exitCode = 1;
			} else {
				console.log(`Resolved manifest is valid: ${absolutePath}`);
			}
		} catch (error) {
			console.error(`${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 1;
		}
	}
}
