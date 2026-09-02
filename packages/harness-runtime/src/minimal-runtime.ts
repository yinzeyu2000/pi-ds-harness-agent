import { type AgentTool, InMemorySessionRepo, type Session, type StreamFn } from "@earendil-works/pi-agent-core";
import { PiAgentDriver } from "./pi-agent-driver.ts";
import { type HarnessPlugin, PluginHost, type PluginSpec } from "./plugin-host.ts";
import { type Bundle, composeProfile, type Profile, type ResolvedProfile } from "./profile.ts";
import { createServiceToken } from "./services.ts";

export const SESSION_SERVICE = createServiceToken<Session>("pi-ds.session");
export const TOOLS_SERVICE = createServiceToken<AgentTool[]>("pi-ds.tools");
export const PROMPT_SERVICE = createServiceToken<string>("pi-ds.prompt");
export const AGENT_DRIVER_SERVICE = createServiceToken<PiAgentDriver>("pi-ds.agent-driver");

const minimalBundle: Bundle = {
	id: "minimal",
	plugins: [
		{ id: "session-memory", plugin: "session-memory", scope: "agent" },
		{ id: "tools", plugin: "tools-static", scope: "agent" },
		{ id: "prompt", plugin: "prompt-static", scope: "agent" },
		{ id: "driver", plugin: "pi-agent-driver", scope: "agent" },
	],
};

export const MINIMAL_PROFILE: Profile = { id: "minimal", bundles: ["minimal"] };

export function resolveMinimalProfile(): ResolvedProfile {
	return composeProfile(MINIMAL_PROFILE, new Map([[minimalBundle.id, minimalBundle]]));
}

export interface MinimalRuntimeOptions {
	streamFn: StreamFn;
	tools?: AgentTool[];
	systemPrompt?: string;
	/** Use a pre-opened durable session, such as a JsonlSessionRepo session. */
	session?: Session;
	sessionRepo?: InMemorySessionRepo;
	sessionId?: string;
}

export interface MinimalRuntime {
	profile: ResolvedProfile;
	session: Session;
	driver: PiAgentDriver;
	dispose(): Promise<void>;
}

export async function createMinimalRuntime(options: MinimalRuntimeOptions): Promise<MinimalRuntime> {
	if (options.session && (options.sessionRepo || options.sessionId)) {
		throw new Error("session cannot be combined with sessionRepo or sessionId");
	}
	const host = new PluginHost();
	const sessionConfig: SessionPluginConfig = options.session
		? { session: options.session }
		: { repo: options.sessionRepo ?? new InMemorySessionRepo(), sessionId: options.sessionId };
	const specs: PluginSpec[] = [
		{
			plugin: sessionPlugin,
			config: sessionConfig,
		},
		{ plugin: toolsPlugin, config: options.tools ?? [] },
		{ plugin: promptPlugin, config: options.systemPrompt ?? "You are a helpful assistant." },
		{ plugin: driverPlugin, config: { streamFn: options.streamFn } },
	];
	await host.start(specs);
	return {
		profile: resolveMinimalProfile(),
		session: host.require(SESSION_SERVICE),
		driver: host.require(AGENT_DRIVER_SERVICE),
		dispose: () => host.stop(),
	};
}

type SessionPluginConfig = { session: Session } | { repo: InMemorySessionRepo; sessionId?: string };

const sessionPlugin: HarnessPlugin<SessionPluginConfig> = {
	manifest: { id: "session-memory", version: "0.1.0", provides: [SESSION_SERVICE] },
	async activate(context, config) {
		if ("session" in config) {
			context.provide(SESSION_SERVICE, config.session);
			return;
		}
		const existing = config.sessionId
			? (await config.repo.list()).find((metadata) => metadata.id === config.sessionId)
			: undefined;
		const session = existing ? await config.repo.open(existing) : await config.repo.create({ id: config.sessionId });
		context.provide(SESSION_SERVICE, session);
	},
};

const toolsPlugin: HarnessPlugin<AgentTool[]> = {
	manifest: { id: "tools-static", version: "0.1.0", provides: [TOOLS_SERVICE] },
	activate(context, tools) {
		context.provide(TOOLS_SERVICE, tools.slice());
	},
};

const promptPlugin: HarnessPlugin<string> = {
	manifest: { id: "prompt-static", version: "0.1.0", provides: [PROMPT_SERVICE] },
	activate(context, prompt) {
		context.provide(PROMPT_SERVICE, prompt);
	},
};

const driverPlugin: HarnessPlugin<{ streamFn: StreamFn }> = {
	manifest: {
		id: "pi-agent-driver",
		version: "0.1.0",
		provides: [AGENT_DRIVER_SERVICE],
		requires: [SESSION_SERVICE, TOOLS_SERVICE, PROMPT_SERVICE],
	},
	async activate(context, config) {
		const driver = await PiAgentDriver.create({
			session: context.require(SESSION_SERVICE),
			streamFn: config.streamFn,
			tools: context.require(TOOLS_SERVICE),
			systemPrompt: context.require(PROMPT_SERVICE),
		});
		context.provide(AGENT_DRIVER_SERVICE, driver);
		return driver;
	},
};
