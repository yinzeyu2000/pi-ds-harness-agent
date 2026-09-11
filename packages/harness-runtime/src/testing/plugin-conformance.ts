import { PluginHost, type PluginSpec } from "../plugin-host.ts";

export type PluginConformanceIssueCode =
	| "invalid_manifest"
	| "activation_failed"
	| "missing_declared_service"
	| "disposal_failed"
	| "scope_leak";

export interface PluginConformanceIssue {
	code: PluginConformanceIssueCode;
	message: string;
	error?: unknown;
}

export interface PluginConformanceReport {
	pluginId: string;
	ok: boolean;
	issues: PluginConformanceIssue[];
}

export async function inspectPluginConformance(spec: PluginSpec): Promise<PluginConformanceReport> {
	const pluginId = spec.plugin.manifest.id;
	const issues: PluginConformanceIssue[] = [];
	if (pluginId.trim().length === 0 || spec.plugin.manifest.version.trim().length === 0) {
		issues.push({ code: "invalid_manifest", message: "Plugin id and version must not be empty" });
		return { pluginId, ok: false, issues };
	}
	const host = new PluginHost();
	let activated = false;
	try {
		await host.start([spec]);
		activated = true;
	} catch (error) {
		issues.push({ code: "activation_failed", message: "Plugin activation failed", error });
	}
	if (activated) {
		for (const token of spec.plugin.manifest.provides ?? []) {
			if (host.get(token) === undefined) {
				issues.push({
					code: "missing_declared_service",
					message: `Plugin did not provide declared service ${token.id}`,
				});
			}
		}
	}
	try {
		await host.stop();
		await host.stop();
	} catch (error) {
		issues.push({ code: "disposal_failed", message: "Plugin disposal failed", error });
	}
	if (host.activePluginCount !== 0 || host.serviceCount !== 0) {
		issues.push({ code: "scope_leak", message: "Plugin resources remained registered after disposal" });
	}
	return { pluginId, ok: issues.length === 0, issues };
}

export async function assertPluginConforms(spec: PluginSpec): Promise<void> {
	const report = await inspectPluginConformance(spec);
	if (!report.ok) {
		throw new AggregateError(
			report.issues.map((issue) => issue.error ?? new Error(issue.message)),
			`Plugin ${report.pluginId} failed conformance`,
		);
	}
}
