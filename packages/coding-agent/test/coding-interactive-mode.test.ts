import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { AgentEvent, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { type EditorComponent, type Terminal, Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createCodingRuntime } from "../src/core/coding-runtime.ts";
import { CodingRuntimeHost, type CodingRuntimeTarget } from "../src/core/coding-runtime-host.ts";
import type { CodingRuntimeSnapshot } from "../src/core/coding-runtime-projection.ts";
import {
	CodingInteractiveMode,
	type CodingInteractiveSessionInfo,
	type CodingInteractiveTreeItem,
	type CodingInteractiveView,
	type CodingInteractiveViewHandlers,
	PiCodingInteractiveView,
} from "../src/modes/interactive/coding-interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

class FakeInteractiveView implements CodingInteractiveView {
	readonly snapshots: CodingRuntimeSnapshot[] = [];
	readonly statuses: string[] = [];
	readonly errors: string[] = [];
	readonly agentEventTypes: AgentEvent["type"][] = [];
	readonly sessionSelections: Array<{ ids: string[]; currentSessionPath: string }> = [];
	readonly treeSelections: Array<{ ids: string[]; currentLeafId: string | null }> = [];
	readonly modelSelections: Array<{ ids: string[]; currentId: string }> = [];
	readonly toolSelections: Array<{ names: string[]; activeNames: string[] }> = [];
	nextSessionSelection?: string;
	nextThinkingLevel?: ThinkingLevel;
	nextModel?: Model<Api>;
	nextTools?: string[];
	treeSelectionResolver?: (entries: readonly CodingInteractiveTreeItem[]) => string | undefined;
	started = false;
	stopped = false;
	private handlers?: CodingInteractiveViewHandlers;

	setHandlers(handlers: CodingInteractiveViewHandlers): void {
		this.handlers = handlers;
	}

	start(): void {
		this.started = true;
	}

	stop(): void {
		this.stopped = true;
	}

	render(snapshot: CodingRuntimeSnapshot): void {
		this.snapshots.push(structuredClone(snapshot));
	}

	renderAgentEvent(event: AgentEvent): void {
		this.agentEventTypes.push(event.type);
	}

	showStatus(message: string): void {
		this.statuses.push(message);
	}

	showError(message: string): void {
		this.errors.push(message);
	}

	requestApproval(): Promise<boolean> {
		return Promise.resolve(true);
	}

	selectSession(
		sessions: readonly CodingInteractiveSessionInfo[],
		currentSessionPath: string,
	): Promise<string | undefined> {
		this.sessionSelections.push({ ids: sessions.map((session) => session.id), currentSessionPath });
		return Promise.resolve(this.nextSessionSelection);
	}

	selectTree(
		entries: readonly CodingInteractiveTreeItem[],
		currentLeafId: string | null,
	): Promise<string | undefined> {
		this.treeSelections.push({ ids: entries.map((entry) => entry.id), currentLeafId });
		return Promise.resolve(this.treeSelectionResolver?.(entries));
	}

	selectThinkingLevel(): Promise<ThinkingLevel | undefined> {
		return Promise.resolve(this.nextThinkingLevel);
	}

	selectModel(models: readonly Model<Api>[], current: Model<Api>): Promise<Model<Api> | undefined> {
		this.modelSelections.push({ ids: models.map(({ id }) => id), currentId: current.id });
		return Promise.resolve(this.nextModel);
	}

	selectTools(
		tools: readonly { name: string; description: string }[],
		activeNames: readonly string[],
	): Promise<string[] | undefined> {
		this.toolSelections.push({ names: tools.map(({ name }) => name), activeNames: [...activeNames] });
		return Promise.resolve(this.nextTools);
	}

	submit(input: string): void {
		this.handlers?.submit(input);
	}

	abort(): void {
		this.handlers?.abort();
	}

	exit(): void {
		this.handlers?.exit();
	}
}

class FakeTerminal implements Terminal {
	columns = 100;
	rows = 30;
	kittyProtocolActive = false;
	stopped = false;
	title = "";
	private onInput: (data: string) => void = () => undefined;

	start(onInput: (data: string) => void): void {
		this.onInput = onInput;
	}

	stop(): void {
		this.stopped = true;
	}

	drainInput(): Promise<void> {
		return Promise.resolve();
	}

	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(title: string): void {
		this.title = title;
	}
	setProgress(): void {}

	input(data: string): void {
		this.onInput(data);
	}
}

class FakeEditor extends Text implements EditorComponent {
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;
	disposed = false;
	private value = "";

	constructor() {
		super("", 0, 0);
	}

	getText(): string {
		return this.value;
	}

	setText(text: string): void {
		this.value = text;
		this.onChange?.(text);
	}

	handleInput(data: string): void {
		if (data === "\r") this.onSubmit?.(this.value);
		else this.setText(this.value + data);
	}

	dispose(): void {
		this.disposed = true;
	}
}

function responseStream(): StreamFn {
	let response = 0;
	return () => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const text = `response ${++response}`;
			const started = assistantMessage("", "pending");
			const partial = assistantMessage(text, "pending");
			const completed = assistantMessage(text, "stop");
			stream.push({ type: "start", partial: started });
			stream.push({ type: "text_start", contentIndex: 0, partial: assistantMessage("", "pending") });
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
			stream.push({
				type: "done",
				reason: "stop",
				message: completed,
			});
		});
		return stream;
	};
}

function assistantMessage(text: string, stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function reasoningModel(id = "faux-1"): Model<Api> {
	return {
		id,
		name: "Faux Reasoning",
		api: "openai-completions",
		provider: "faux",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	};
}

describe("Coding Harness interactive mode", () => {
	it("collects tool approval inside the focused TUI editor", async () => {
		initTheme("dark");
		const terminal = new FakeTerminal();
		const view = new PiCodingInteractiveView({ terminal });
		view.setHandlers({ submit: () => undefined, abort: () => undefined, exit: () => undefined });
		view.start();

		const approval = view.requestApproval("Allow write?");
		terminal.input("yes");
		terminal.input("\r");
		expect(await approval).toBe(true);

		const selection = view.selectSession(
			[
				{
					id: "source",
					cwd: "C:\\project",
					path: "C:\\sessions\\source.jsonl",
					createdAt: 1,
					modifiedAt: 2,
				},
			],
			"source",
		);
		terminal.input("\r");
		expect(await selection).toBe("C:\\sessions\\source.jsonl");

		const treeSelection = view.selectTree(
			[{ id: "entry", parentId: null, seq: 1, type: "message", text: "user: hello" }],
			"entry",
		);
		terminal.input("\r");
		expect(await treeSelection).toBe("entry");

		const thinkingSelection = view.selectThinkingLevel("medium", ["off", "medium"]);
		terminal.input("\r");
		expect(await thinkingSelection).toBe("medium");

		const model = reasoningModel();
		const modelSelection = view.selectModel([model], model);
		terminal.input("\r");
		expect(await modelSelection).toBe(model);

		const toolSelection = view.selectTools([{ name: "read", description: "Read files" }], ["read"]);
		terminal.input("\r");
		expect(await toolSelection).toEqual(["read"]);

		const extensionUI = view.getExtensionUIContext();
		const extensionSelection = extensionUI.select("Choose a lane", ["main", "review"]);
		terminal.input("\r");
		expect(await extensionSelection).toBe("main");

		const confirmation = extensionUI.confirm("Continue", "Apply changes?");
		terminal.input("\r");
		expect(await confirmation).toBe(true);

		const input = extensionUI.input("Session name", "optional");
		terminal.input("Harness child");
		terminal.input("\r");
		expect(await input).toBe("Harness child");

		const editor = extensionUI.editor("Instructions", "preserve state");
		terminal.input("\r");
		expect(await editor).toBe("preserve state");

		extensionUI.setEditorText("queued prompt");
		expect(extensionUI.getEditorText()).toBe("queued prompt");
		extensionUI.setTitle("Harness Extension");
		expect(terminal.title).toBe("Harness Extension");

		let widgetDisposed = false;
		extensionUI.setWidget("progress", () =>
			Object.assign(new Text("Working", 1, 0), {
				dispose: () => {
					widgetDisposed = true;
				},
			}),
		);
		let headerDisposed = false;
		extensionUI.setHeader(() =>
			Object.assign(new Text("Custom header", 1, 0), {
				dispose: () => {
					headerDisposed = true;
				},
			}),
		);
		extensionUI.setStatus("extension", "ready");
		let footerStatuses: ReadonlyMap<string, string> | undefined;
		let footerDisposed = false;
		extensionUI.setFooter((_ui, _theme, footerData) => {
			footerStatuses = footerData.getExtensionStatuses();
			return Object.assign(new Text("Custom footer", 1, 0), {
				dispose: () => {
					footerDisposed = true;
				},
			});
		});
		expect(footerStatuses?.get("extension")).toBe("ready");

		let customEditor: FakeEditor | undefined;
		const editorFactory = () => {
			customEditor = new FakeEditor();
			return customEditor;
		};
		extensionUI.setEditorComponent(editorFactory);
		expect(extensionUI.getEditorComponent()).toBe(editorFactory);
		extensionUI.setEditorText("custom input");
		terminal.input("!");
		expect(extensionUI.getEditorText()).toBe("custom input!");
		expect(extensionUI.getAllThemes().map(({ name }) => name)).toEqual(expect.arrayContaining(["dark", "light"]));
		expect(extensionUI.getTheme("dark")).toBeDefined();
		expect(extensionUI.setTheme("dark")).toEqual({ success: true });

		let finishCustom: ((value: string) => void) | undefined;
		let customDisposed = false;
		const customResult = extensionUI.custom<string>((_ui, _theme, _keybindings, done) => {
			finishCustom = done;
			return Object.assign(new Text("Custom dialog", 1, 0), {
				dispose: () => {
					customDisposed = true;
				},
			});
		});
		await Promise.resolve();
		finishCustom?.("complete");
		expect(await customResult).toBe("complete");
		expect(customDisposed).toBe(true);

		let rawInputCount = 0;
		extensionUI.onTerminalInput(() => {
			rawInputCount++;
			return undefined;
		});
		terminal.input("x");
		expect(rawInputCount).toBe(1);
		view.resetExtensionUI();
		expect(widgetDisposed).toBe(true);
		expect(headerDisposed).toBe(true);
		expect(footerDisposed).toBe(true);
		expect(customEditor?.disposed).toBe(true);
		expect(extensionUI.getEditorComponent()).toBeUndefined();
		terminal.input("z");
		expect(rawInputCount).toBe(1);

		const extensionAbort = new AbortController();
		const abortedSelection = extensionUI.select("Cancelled", ["one"], { signal: extensionAbort.signal });
		extensionAbort.abort();
		expect(await abortedSelection).toBeUndefined();

		const cancelledInput = extensionUI.input("Cancelled input");
		view.cancelPendingInteractions();
		expect(await cancelledInput).toBeUndefined();

		const abort = new AbortController();
		const denied = view.requestApproval("Allow bash?", abort.signal);
		abort.abort();
		expect(await denied).toBe(false);
		view.stop();
		expect(terminal.stopped).toBe(true);
	});

	it("renders canonical projections and routes interactive commands through the Runtime host", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-interactive-mode-"));
		const otherCwd = await mkdtemp(join(tmpdir(), "pi-ds-interactive-other-project-"));
		const sessionsRoot = join(cwd, ".sessions");
		let activeModel = reasoningModel();
		let activeThinkingLevel: ThinkingLevel = "medium";
		let activeTools: Array<"read"> = ["read"];
		const create = (target: CodingRuntimeTarget) =>
			createCodingRuntime({
				cwd: target.cwd,
				sessionsRoot,
				sessionId: target.sessionId,
				streamFn: responseStream(),
				model: activeModel,
				thinkingLevel: activeThinkingLevel,
				toolNames: activeTools,
				includeDefaultSkills: false,
				compaction: {
					settings: { enabled: false, reserveTokens: 100, keepRecentTokens: 0 },
					execute: async () => {
						throw new Error("not used");
					},
					summarizeBranch: async (_entries, request) => {
						expect(request.customInstructions).toBe("focus");
						return {
							summary: "Abandoned branch summary",
							readFiles: [],
							modifiedFiles: [],
						};
					},
				},
			});
		let host: CodingRuntimeHost | undefined;
		try {
			const otherRuntime = await create({ sessionId: "other", cwd });
			const otherSessionPath = otherRuntime.sessionPath;
			await otherRuntime.dispose();
			const crossProjectRuntime = await create({ sessionId: "cross-project", cwd: otherCwd });
			const crossProjectSessionPath = crossProjectRuntime.sessionPath;
			await crossProjectRuntime.dispose();
			const activeHost = await CodingRuntimeHost.create(await create({ sessionId: "interactive", cwd }), create);
			host = activeHost;
			const view = new FakeInteractiveView();
			const alternateModel = reasoningModel("faux-2");
			const mode = new CodingInteractiveMode(activeHost, {
				view,
				initialInputs: ["initial"],
				availableModels: () => [activeModel, alternateModel],
				onModelChanged: (model) => {
					activeModel = model;
				},
				onThinkingLevelChanged: (level) => {
					activeThinkingLevel = level;
				},
				onToolsChanged: (names) => {
					activeTools = names.filter((name): name is "read" => name === "read");
				},
			});
			const running = mode.run();

			await mode.settle();
			expect(view.started).toBe(true);
			expect(view.agentEventTypes).toContain("message_update");
			expect(view.snapshots.at(-1)?.projection.messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
			]);

			view.submit("follow up");
			await mode.settle();
			expect(view.snapshots.at(-1)?.projection.messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"user",
				"assistant",
			]);

			const exportPath = join(cwd, "exports", "interactive.html");
			view.submit(`/export ${exportPath}`);
			await mode.settle();
			expect(await readFile(exportPath, "utf8")).toContain('<script id="session-data" type="application/json">');
			expect(view.statuses.at(-1)).toBe(`Exported Session to ${exportPath}`);

			view.submit("/name Harness TUI");
			await mode.settle();
			expect(view.snapshots.at(-1)?.session.name).toBe("Harness TUI");

			view.submit("/session");
			await mode.settle();
			expect(view.statuses.at(-1)).toContain("interactive");
			expect(view.errors).toEqual([]);

			view.treeSelectionResolver = (entries) => entries.find((entry) => entry.text.includes("user: initial"))?.id;
			view.submit("/tree summarize focus");
			await mode.settle();
			expect(view.treeSelections.at(-1)?.currentLeafId).toBeTruthy();
			expect(view.snapshots.at(-1)?.projection.messages.map((message) => message.role)).toEqual([
				"user",
				"branchSummary",
			]);
			expect(view.statuses.at(-1)).toContain("with branch summary");

			view.nextThinkingLevel = "high";
			view.submit("/thinking");
			await mode.settle();
			expect(view.snapshots.at(-1)?.thinkingLevel).toBe("high");
			expect(view.statuses.at(-1)).toBe("Thinking level: high");

			view.nextModel = alternateModel;
			view.submit("/model");
			await mode.settle();
			expect(view.modelSelections.at(-1)).toEqual({ ids: ["faux-1", "faux-2"], currentId: "faux-1" });
			expect(view.snapshots.at(-1)?.model.id).toBe("faux-2");
			expect(view.statuses.at(-1)).toBe("Model: faux/faux-2");

			view.nextTools = [];
			view.submit("/tools");
			await mode.settle();
			expect(view.toolSelections.at(-1)).toEqual({ names: ["read"], activeNames: ["read"] });
			expect(view.snapshots.at(-1)?.toolNames).toEqual([]);
			expect(view.statuses.at(-1)).toBe("Tools: none");

			view.submit("/fork interactive-fork");
			await mode.settle();
			expect(view.errors).toEqual([]);
			expect(view.snapshots.at(-1)?.session.id).toBe("interactive-fork");
			expect(view.snapshots.at(-1)?.projection.messages.map((message) => message.role)).toEqual([
				"user",
				"branchSummary",
			]);
			expect(view.snapshots.at(-1)?.model.id).toBe("faux-2");
			expect(view.snapshots.at(-1)?.thinkingLevel).toBe("high");
			expect(view.snapshots.at(-1)?.toolNames).toEqual([]);
			expect(view.statuses.at(-1)).toBe("Forked and switched to Session interactive-fork");

			view.nextSessionSelection = otherSessionPath;
			view.submit("/sessions");
			await mode.settle();
			expect(view.sessionSelections.at(-1)?.currentSessionPath).toContain("interactive-fork.jsonl");
			expect(view.sessionSelections.at(-1)?.ids).toEqual(
				expect.arrayContaining(["interactive", "interactive-fork", "other"]),
			);
			expect(view.snapshots.at(-1)?.session.id).toBe("other");
			expect(view.statuses.at(-1)).toBe(`Switched to Session other · ${cwd}`);

			view.nextSessionSelection = crossProjectSessionPath;
			view.submit("/sessions all");
			await mode.settle();
			expect(view.sessionSelections.at(-1)?.ids).toContain("cross-project");
			expect(view.snapshots.at(-1)?.session).toMatchObject({ id: "cross-project", cwd: otherCwd });
			expect(view.statuses.at(-1)).toBe(`Switched to Session cross-project · ${otherCwd}`);

			view.submit(`/session ${relative(otherCwd, otherSessionPath)}`);
			await mode.settle();
			expect(view.snapshots.at(-1)?.session).toMatchObject({ id: "other", cwd });

			view.submit("/new interactive-new");
			await mode.settle();
			expect(view.snapshots.at(-1)?.session).toMatchObject({ id: "interactive-new", cwd });
			expect(view.statuses.at(-1)).toBe("Started new Session interactive-new");

			view.submit("/reload");
			await mode.settle();
			expect(view.snapshots.at(-1)?.session).toMatchObject({ id: "interactive-new", cwd });
			expect(view.statuses.at(-1)).toBe("Reloaded Session interactive-new");

			view.exit();
			expect(await running).toBe(0);
			expect(view.stopped).toBe(true);
			expect(() => activeHost.snapshot).toThrow("disposed");
			host = undefined;
		} finally {
			await host?.dispose();
			await rm(cwd, { recursive: true, force: true });
			await rm(otherCwd, { recursive: true, force: true });
		}
	});

	it("reports unknown slash commands without creating durable messages", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-interactive-command-"));
		const create = (target: CodingRuntimeTarget) =>
			createCodingRuntime({
				cwd: target.cwd,
				sessionsRoot: join(cwd, ".sessions"),
				sessionId: target.sessionId,
				streamFn: responseStream(),
				toolNames: [],
				includeDefaultSkills: false,
				compaction: {
					settings: { enabled: false, reserveTokens: 100, keepRecentTokens: 0 },
					execute: async () => {
						throw new Error("not used");
					},
				},
			});
		let host: CodingRuntimeHost | undefined;
		try {
			const activeHost = await CodingRuntimeHost.create(await create({ sessionId: "commands", cwd }), create);
			host = activeHost;
			const view = new FakeInteractiveView();
			const mode = new CodingInteractiveMode(activeHost, { view });
			const running = mode.run();

			view.submit("/missing");
			await mode.settle();
			expect(view.errors).toEqual(["Unknown command: /missing"]);
			expect(view.snapshots.at(-1)?.projection.messages).toEqual([]);

			view.submit("/quit");
			expect(await running).toBe(0);
			expect(view.stopped).toBe(true);
			host = undefined;
		} finally {
			await host?.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("does not submit initial input when its signal was already aborted", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-ds-interactive-abort-"));
		const create = (target: CodingRuntimeTarget) =>
			createCodingRuntime({
				cwd: target.cwd,
				sessionsRoot: join(cwd, ".sessions"),
				sessionId: target.sessionId,
				streamFn: responseStream(),
				toolNames: [],
				includeDefaultSkills: false,
				compaction: {
					settings: { enabled: false, reserveTokens: 100, keepRecentTokens: 0 },
					execute: async () => {
						throw new Error("not used");
					},
				},
			});
		let host: CodingRuntimeHost | undefined;
		try {
			const activeHost = await CodingRuntimeHost.create(await create({ sessionId: "pre-aborted", cwd }), create);
			host = activeHost;
			const view = new FakeInteractiveView();
			const abort = new AbortController();
			abort.abort();

			const result = await new CodingInteractiveMode(activeHost, {
				view,
				initialInputs: ["must not be submitted"],
				signal: abort.signal,
			}).run();

			expect(result).toBe(0);
			expect(view.started).toBe(true);
			expect(view.stopped).toBe(true);
			expect(view.snapshots.at(-1)?.projection.messages).toEqual([]);
			host = undefined;
		} finally {
			await host?.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
