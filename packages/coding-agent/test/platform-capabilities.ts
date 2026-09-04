import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function detectFileSymlinkSupport(): boolean {
	const directory = mkdtempSync(join(tmpdir(), "pi-symlink-probe-"));
	try {
		const target = join(directory, "target.txt");
		writeFileSync(target, "probe");
		symlinkSync(target, join(directory, "link.txt"), "file");
		return true;
	} catch {
		return false;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

export const supportsFileSymlinks = detectFileSymlinkSupport();
