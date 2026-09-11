import type {
	AgentEvent,
	AgentMessage,
	CompactionEntry,
	Entry,
	JsonlSessionMetadata,
	LanePointer,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { PiAgentDriver, PiAgentRecoveryState } from "@pi-ds/harness-runtime";
import type { CodingRuntime } from "./coding-runtime.ts";
import {
	CodingRuntimeProjection,
	type CodingRuntimeSnapshot,
	type CodingRuntimeSnapshotListener,
} from "./coding-runtime-projection.ts";

export type CodingRuntimeDelivery = "auto" | "prompt" | "steer" | "followUp";

export interface CodingRuntimeCommandInfo {
	name: string;
	description?: string;
}

/** Single consumer port for TUI and protocol adapters. */
export class CodingRuntimeController {
	readonly projection: CodingRuntimeProjection;
	private readonly runtime: CodingRuntime;
	private disposed = false;

	private constructor(runtime: CodingRuntime, projection: CodingRuntimeProjection) {
		this.runtime = runtime;
		this.projection = projection;
	}

	static async create(runtime: CodingRuntime): Promise<CodingRuntimeController> {
		return new CodingRuntimeController(runtime, await CodingRuntimeProjection.create(runtime));
	}

	get snapshot(): CodingRuntimeSnapshot {
		this.assertActive();
		return this.projection.snapshot;
	}

	get isIdle(): boolean {
		this.assertActive();
		return this.runtime.driver.isIdle() && !this.runtime.driver.hasPendingMessages();
	}

	get driver(): PiAgentDriver {
		this.assertActive();
		return this.runtime.driver;
	}

	subscribe(listener: CodingRuntimeSnapshotListener, emitCurrent = true): () => void {
		this.assertActive();
		return this.projection.subscribe(listener, emitCurrent);
	}

	onAgentEvent(listener: (event: AgentEvent) => void | Promise<void>): () => void {
		this.assertActive();
		return this.runtime.driver.events.on("agent/event", listener);
	}

	get commands(): CodingRuntimeCommandInfo[] {
		this.assertActive();
		return this.runtime.legacyCommands.map(({ invocationName, description }) => ({
			name: invocationName,
			...(description === undefined ? {} : { description }),
		}));
	}

	send(input: string | AgentMessage, delivery: CodingRuntimeDelivery = "auto"): Promise<void> {
		this.assertActive();
		const resolved = delivery === "auto" ? (this.runtime.driver.isIdle() ? "prompt" : "followUp") : delivery;
		switch (resolved) {
			case "prompt":
				return this.runtime.driver.prompt(input);
			case "steer":
				return this.runtime.driver.steer(input);
			case "followUp":
				return this.runtime.driver.followUp(input);
		}
	}

	resume(): Promise<void> {
		this.assertActive();
		return this.runtime.driver.resume();
	}

	getRecoveryState(): Promise<PiAgentRecoveryState> {
		this.assertActive();
		return this.runtime.driver.getRecoveryState();
	}

	compact(customInstructions?: string): Promise<CompactionEntry | undefined> {
		this.assertActive();
		return this.runtime.driver.compact({ customInstructions });
	}

	async invokeCommand(name: string, args = ""): Promise<void> {
		this.assertActive();
		const command = this.runtime.legacyCommands.find((candidate) => candidate.invocationName === name);
		if (!command) throw new Error(`Unknown Extension command: ${name}`);
		await command.execute(args);
		await this.runtime.flushLegacyActions();
		await this.projection.refresh();
	}

	async setSessionName(name: string | undefined): Promise<void> {
		this.assertActive();
		await this.runtime.session.setName(name?.trim() || undefined);
		await this.runtime.session.flush();
		await this.projection.refresh();
	}

	async setActiveTools(names: string[]): Promise<void> {
		this.assertActive();
		this.runtime.legacyExtensionSet.runtime.setActiveTools(names);
		await this.projection.refresh();
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		this.assertActive();
		this.runtime.legacyExtensionSet.runtime.setThinkingLevel(level);
		await this.projection.refresh();
	}

	async setModel(model: Model<Api>): Promise<void> {
		this.assertActive();
		this.runtime.driver.setModel(model);
		await this.projection.refresh();
	}

	async getTree(): Promise<{ lanes: LanePointer[]; entries: Entry[] }> {
		this.assertActive();
		const [lanes, entries] = await Promise.all([
			this.runtime.session.getLanes(),
			this.runtime.session.findEntries({ order: "oldestFirst" }),
		]);
		return { lanes, entries };
	}

	async navigateTo(entryId: string | null): Promise<void> {
		this.assertActive();
		await this.runtime.driver.navigateTo(entryId);
		await this.projection.refresh();
	}

	forkSession(options?: Parameters<CodingRuntime["forkSession"]>[0]): Promise<JsonlSessionMetadata> {
		this.assertActive();
		return this.runtime.forkSession(options);
	}

	abort(): void {
		this.assertActive();
		this.runtime.driver.abort();
	}

	waitForIdle(): Promise<void> {
		this.assertActive();
		return this.runtime.driver.waitForIdle();
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.projection.dispose();
		await this.runtime.flushLegacyActions();
		await this.runtime.dispose();
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("Coding Runtime Controller is disposed");
	}
}
