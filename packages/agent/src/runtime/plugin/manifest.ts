export interface ServiceRef {
	readonly id: string;
	readonly version?: string;
	readonly versionRange?: string;
	readonly cardinality?: "one" | "many";
}

export interface PluginManifest {
	readonly id: string;
	readonly version: string;
	readonly provides?: readonly ServiceRef[];
	readonly requires?: readonly ServiceRef[];
	readonly optional?: readonly ServiceRef[];
	readonly capabilities?: readonly string[];
}

export function parseSemver(v: string): [number, number, number] | undefined {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function matchesSemver(version: string, range?: string): boolean {
	if (!range || range === "*" || range === "latest") return true;
	const v = parseSemver(version);
	if (!v) return false;

	const trimmed = range.trim();

	// ^1.2.3 (compatible with major version >= minor/patch)
	if (trimmed.startsWith("^")) {
		const target = parseSemver(trimmed.slice(1));
		if (!target) return false;
		if (v[0] !== target[0]) return false;
		if (v[1] < target[1]) return false;
		if (v[1] === target[1] && v[2] < target[2]) return false;
		return true;
	}

	// ~1.2.3 (compatible with major.minor >= patch)
	if (trimmed.startsWith("~")) {
		const target = parseSemver(trimmed.slice(1));
		if (!target) return false;
		if (v[0] !== target[0] || v[1] !== target[1]) return false;
		return v[2] >= target[2];
	}

	// >=1.2.3
	if (trimmed.startsWith(">=")) {
		const target = parseSemver(trimmed.slice(2));
		if (!target) return false;
		if (v[0] > target[0]) return true;
		if (v[0] === target[0] && v[1] > target[1]) return true;
		if (v[0] === target[0] && v[1] === target[1] && v[2] >= target[2]) return true;
		return false;
	}

	// Exact match
	const target = parseSemver(trimmed);
	if (!target) return version.trim() === trimmed;
	return v[0] === target[0] && v[1] === target[1] && v[2] === target[2];
}
