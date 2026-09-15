import {
	type AgentEvent,
	type AgentMessage,
	type CompactionEntry,
	calculateContextTokens,
	type Entry,
	estimateContextTokens,
	type JsonlSessionMetadata,
	type LanePointer,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, contentText, type Model } from "@earendil-works/pi-ai";
import type { PiAgentDriver, PiAgentRecoveryState } from "@pi-ds/harness-runtime";
import type { CodingRuntime } from "./coding-runtime.ts";
import {
	CodingRuntimeProjection,
	type CodingRuntimeSnapshot,
	type CodingRuntimeSnapshotListener,
} from "./coding-runtime-projection.ts";
import { exportCanonicalSessionToHtml } from "./export-html/index.ts";
import { expandPromptTemplate } from "./prompt-templates.ts";

export type CodingRuntimeDelivery = "auto" | "prompt" | "steer" | "followUp";

export interface CodingRuntimeCommandInfo {
	name: string;
	description?: string;
	source: "extension" | "prompt";
}

export interface CodingRuntimeToolInfo {
	name: string;
	description: string;
}

export interface CodingRuntimeSessionStats {
	sessionFile: string;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
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
		const extensionCommands = this.runtime.legacyCommands.map(({ invocationName, description }) => ({
			name: invocationName,
			...(description === undefined ? {} : { description }),
			source: "extension" as const,
		}));
		const extensionNames = new Set(extensionCommands.map(({ name }) => name));
		return [
			...extensionCommands,
			...this.runtime.promptTemplates
				.filter(({ name }) => !extensionNames.has(name))
				.map(({ name, description }) => ({ name, description, source: "prompt" as const })),
		];
	}

	get availableTools(): CodingRuntimeToolInfo[] {
		this.assertActive();
		return this.runtime.toolCatalog.list().map(({ name, description }) => ({ name, description }));
	}

	send(input: string | AgentMessage, delivery: CodingRuntimeDelivery = "auto"): Promise<void> {
		this.assertActive();
		const expandedInput = expandRuntimePrompt(input, this.runtime.promptTemplates);
		const resolved = delivery === "auto" ? (this.runtime.driver.isIdle() ? "prompt" : "followUp") : delivery;
		switch (resolved) {
			case "prompt":
				return this.runtime.driver.prompt(expandedInput);
			case "steer":
				return this.runtime.driver.steer(expandedInput);
			case "followUp":
				return this.runtime.driver.followUp(expandedInput);
		}
	}

	resume(): Promise<void> {
		this.assertActive();
		return this.runtime.driver.resume();
	}

	async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		this.assertActive();
		const cleared = await this.runtime.driver.clearQueue();
		await this.projection.refresh();
		return {
			steering: cleared.steering.map(queuedMessageText),
			followUp: cleared.followUp.map(queuedMessageText),
		};
	}

	exportHtml(outputPath?: string): Promise<string> {
		this.assertActive();
		return exportCanonicalSessionToHtml(
			{
				session: this.runtime.session,
				sessionPath: this.runtime.sessionPath,
				sessionId: this.runtime.sessionId,
				cwd: this.runtime.cwd,
				systemPrompt: this.runtime.driver.systemPrompt,
			},
			{ outputPath },
		);
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
		if (!command) {
			if (!this.runtime.promptTemplates.some((template) => template.name === name)) {
				throw new Error(`Unknown Extension command: ${name}`);
			}
			await this.send(`/${name}${args ? ` ${args}` : ""}`, "auto");
			return;
		}
		await command.execute(args);
		if (this.disposed) return;
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

	async getEntries(since?: string): Promise<{ entries: Entry[]; leafId: string | null }> {
		this.assertActive();
		const [lanes, allEntries] = await Promise.all([
			this.runtime.session.getLanes(),
			this.runtime.session.findEntries({ order: "oldestFirst" }),
		]);
		let entries = allEntries;
		if (since !== undefined) {
			const index = entries.findIndex((entry) => entry.id === since);
			if (index < 0) throw new Error(`Entry not found: ${since}`);
			entries = entries.slice(index + 1);
		}
		const leafId = lanes.find(({ lane }) => lane === "main")?.leafId;
		if (leafId === undefined) throw new Error("Session lane does not exist: main");
		return { entries, leafId };
	}

	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		this.assertActive();
		const entries = await this.runtime.session.findEntries({ order: "oldestFirst" });
		const messages: Array<{ entryId: string; text: string }> = [];
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const text = contentText(entry.message.content, "");
			if (text) messages.push({ entryId: entry.id, text });
		}
		return messages;
	}

	async getSessionStats(): Promise<CodingRuntimeSessionStats> {
		this.assertActive();
		const [entries, usageRecords] = await Promise.all([
			this.runtime.session.findEntries({ order: "oldestFirst" }),
			this.runtime.session.findRecords({ type: "usage", order: "oldestFirst" }),
		]);
		let userMessages = 0;
		let assistantMessages = 0;
		let toolCalls = 0;
		let toolResults = 0;
		let totalMessages = 0;
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			totalMessages++;
			if (entry.message.role === "user") userMessages++;
			else if (entry.message.role === "toolResult") toolResults++;
			else if (entry.message.role === "assistant") {
				assistantMessages++;
				toolCalls += entry.message.content.filter((content) => content.type === "toolCall").length;
			}
		}
		const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		let cost = 0;
		for (const record of usageRecords) {
			tokens.input += record.usage.input;
			tokens.output += record.usage.output;
			tokens.cacheRead += record.usage.cacheRead;
			tokens.cacheWrite += record.usage.cacheWrite;
			cost += record.usage.cost.total;
		}
		tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
		await this.projection.refresh();
		const contextUsage = getContextUsage(
			this.projection.snapshot.projection.messages,
			this.runtime.driver.model.contextWindow,
		);
		return {
			sessionFile: this.runtime.sessionPath,
			sessionId: this.runtime.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages,
			tokens,
			cost,
			...(contextUsage === undefined ? {} : { contextUsage }),
		};
	}

	async getLastAssistantText(): Promise<string | null> {
		this.assertActive();
		await this.projection.refresh();
		const messages = this.projection.snapshot.projection.messages;
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (message?.role !== "assistant") continue;
			if (message.stopReason === "aborted" && message.content.length === 0) continue;
			return message.content
				.filter((content) => content.type === "text")
				.map((content) => content.text)
				.join("");
		}
		return null;
	}

	listSessions(scope: "current" | "all" = "current"): Promise<JsonlSessionMetadata[]> {
		this.assertActive();
		return this.runtime.listSessions(scope === "current" ? { cwd: this.runtime.cwd } : {});
	}

	async navigateTo(
		entryId: string | null,
		options?: { summarize?: boolean; customInstructions?: string; label?: string },
	): Promise<void> {
		this.assertActive();
		await this.runtime.driver.navigateTree(entryId, options);
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

function getContextUsage(
	messages: readonly AgentMessage[],
	contextWindow: number,
): CodingRuntimeSessionStats["contextUsage"] {
	if (contextWindow <= 0) return undefined;
	let latestCompactionIndex = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role !== "compactionSummary") continue;
		latestCompactionIndex = index;
		break;
	}
	if (latestCompactionIndex >= 0) {
		const hasPostCompactionUsage = messages.slice(latestCompactionIndex + 1).some((message) => {
			if (message.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") {
				return false;
			}
			return calculateContextTokens((message as AssistantMessage).usage) > 0;
		});
		if (!hasPostCompactionUsage) return { tokens: null, contextWindow, percent: null };
	}
	const estimated = estimateContextTokens([...messages]).tokens;
	return { tokens: estimated, contextWindow, percent: (estimated / contextWindow) * 100 };
}

function queuedMessageText(message: AgentMessage): string {
	switch (message.role) {
		case "user":
		case "assistant":
		case "toolResult":
		case "custom":
			return contentText(message.content, "");
		case "bashExecution":
			return message.command;
		case "branchSummary":
		case "compactionSummary":
			return message.summary;
		default:
			return "";
	}
}

function expandRuntimePrompt(
	input: string | AgentMessage,
	templates: CodingRuntime["promptTemplates"],
): AgentMessage | string {
	if (typeof input === "string") return expandPromptTemplate(input, [...templates]);
	if (input.role !== "user") return input;
	const text = contentText(input.content, "");
	const expanded = expandPromptTemplate(text, [...templates]);
	if (expanded === text) return input;
	if (typeof input.content === "string") return { ...input, content: expanded };
	return {
		...input,
		content: [{ type: "text", text: expanded }, ...input.content.filter((part) => part.type === "image")],
	};
}
