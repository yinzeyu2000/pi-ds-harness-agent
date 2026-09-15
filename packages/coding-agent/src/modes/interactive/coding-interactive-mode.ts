import { resolve } from "node:path";
import type {
	AgentEvent,
	AgentMessage,
	Entry,
	JsonlSessionMetadata,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import * as TuiLayouts from "@earendil-works/pi-tui";
import {
	type Component,
	Container,
	type EditorComponent,
	ProcessTerminal,
	Spacer,
	setKeybindings,
	type Terminal,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { APP_NAME, getAgentDir } from "../../config.ts";
import type { CodingRuntimeToolInfo } from "../../core/coding-runtime-controller.ts";
import type { CodingRuntimeHost } from "../../core/coding-runtime-host.ts";
import type { CodingRuntimeSnapshot } from "../../core/coding-runtime-projection.ts";
import {
	type EditorFactory,
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionWidgetOptions,
	getNoOpExtensionUIContext,
} from "../../core/extensions/index.ts";
import type { ReadonlyFooterDataProvider } from "../../core/footer-data-provider.ts";
import { KeybindingsManager } from "../../core/keybindings.ts";
import type { TuiMode } from "../../core/settings-manager.ts";
import { CodingModelSelectorComponent, modelKey } from "./components/coding-model-selector.ts";
import {
	CodingSessionSelectorComponent,
	type CodingSessionSelectorItem,
} from "./components/coding-session-selector.ts";
import { CodingToolSelectorComponent, type CodingToolSelectorItem } from "./components/coding-tool-selector.ts";
import { CodingTreeSelectorComponent, type CodingTreeSelectorItem } from "./components/coding-tree-selector.ts";
import { CustomEditor } from "./components/custom-editor.ts";
import { ExtensionEditorComponent } from "./components/extension-editor.ts";
import { ExtensionInputComponent } from "./components/extension-input.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { ThinkingSelectorComponent } from "./components/thinking-selector.ts";
import { createInteractiveTui } from "./interactive-mode.ts";
import {
	setTheme as applyTheme,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getThemeByName,
	setThemeInstance,
	type Theme,
	theme,
} from "./theme/theme.ts";

export type CodingInteractiveSessionInfo = CodingSessionSelectorItem;
export type CodingInteractiveTreeItem = CodingTreeSelectorItem;

export interface CodingInteractiveViewHandlers {
	submit(input: string): void;
	abort(): void;
	exit(): void;
}

/** Rendering boundary used by the canonical Harness interactive consumer. */
export interface CodingInteractiveView {
	setHandlers(handlers: CodingInteractiveViewHandlers): void;
	start(): void;
	stop(): void;
	render(snapshot: CodingRuntimeSnapshot): void;
	renderAgentEvent(event: AgentEvent): void;
	showStatus(message: string): void;
	showError(message: string): void;
	requestApproval(message: string, signal?: AbortSignal): Promise<boolean>;
	selectSession(
		sessions: readonly CodingSessionSelectorItem[],
		currentSessionPath: string,
	): Promise<string | undefined>;
	selectTree(entries: readonly CodingTreeSelectorItem[], currentLeafId: string | null): Promise<string | undefined>;
	selectThinkingLevel(current: ThinkingLevel, available: readonly ThinkingLevel[]): Promise<ThinkingLevel | undefined>;
	selectModel(models: readonly Model<Api>[], current: Model<Api>): Promise<Model<Api> | undefined>;
	selectTools(tools: readonly CodingToolSelectorItem[], activeNames: readonly string[]): Promise<string[] | undefined>;
}

export interface PiCodingInteractiveViewOptions {
	terminal?: Terminal;
	tuiMode?: TuiMode;
	showHardwareCursor?: boolean;
	clearOnShrink?: boolean;
	logDirectory?: string;
	fullscreenCopyOnSelect?: boolean;
}

type PendingApproval = {
	resolve: (allowed: boolean) => void;
	removeAbortListener(): void;
};

type PendingSelection = {
	dispose(): void;
	resolve: (value: unknown) => void;
};

/** Minimal Pi TUI renderer whose transcript is rebuilt only from the durable Projection. */
export class PiCodingInteractiveView implements CodingInteractiveView {
	private readonly ui: TUI;
	private readonly transcript = new Container();
	private readonly liveMessage = new Container();
	private readonly notices = new Container();
	private readonly status = new Text("", 1, 0);
	private readonly builtInHeader = new Text(theme.bold(theme.fg("accent", `${APP_NAME} Harness Runtime`)), 1, 1);
	private readonly headerContainer = new Container();
	private readonly widgetContainerAbove = new Container();
	private readonly widgetContainerBelow = new Container();
	private readonly footerContainer = new Container();
	private readonly defaultEditor: CustomEditor;
	private editor: EditorComponent;
	private readonly editorContainer = new Container();
	private readonly keybindings: KeybindingsManager;
	private readonly extensionUI: ExtensionUIContext;
	private readonly extensionStatuses = new Map<string, string>();
	private readonly extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	private readonly extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
	private readonly extensionTerminalInputUnsubscribers = new Set<() => void>();
	private customHeader?: Component & { dispose?(): void };
	private customFooter?: Component & { dispose?(): void };
	private editorComponentFactory?: EditorFactory;
	private baseStatus = "";
	private handlers?: CodingInteractiveViewHandlers;
	private pendingApproval?: PendingApproval;
	private pendingSelection?: PendingSelection;
	private started = false;

	constructor(options: PiCodingInteractiveViewOptions = {}) {
		const renderer = createInteractiveTui({
			tuiMode: options.tuiMode ?? "regular",
			showHardwareCursor: options.showHardwareCursor ?? false,
			logDirectory: options.logDirectory ?? getAgentDir(),
			terminal: options.terminal ?? new ProcessTerminal(),
			fullscreenCopyOnSelect: options.fullscreenCopyOnSelect,
		});
		renderer.setClearOnShrink(options.clearOnShrink ?? false);
		this.ui = renderer;
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, { paddingX: 1 });
		this.editor = this.defaultEditor;
		this.configureCustomEditor(this.defaultEditor);
		this.editorContainer.addChild(this.editor);
		this.footerContainer.addChild(this.status);

		const document = new Container();
		this.headerContainer.addChild(this.builtInHeader);
		document.addChild(this.headerContainer);
		document.addChild(this.transcript);
		document.addChild(this.liveMessage);
		document.addChild(this.notices);
		const components = [
			document,
			this.widgetContainerAbove,
			this.footerContainer,
			this.editorContainer,
			this.widgetContainerBelow,
		] as const;
		for (const component of components) renderer.addChild(component);
		if (TuiLayouts.isViewportTUI(renderer)) {
			const scrollView = new TuiLayouts.ScrollView(document, { follow: "end", primary: true });
			renderer.setLayoutRoot(
				new TuiLayouts.VStack([
					{ component: scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
					{ component: this.widgetContainerAbove, basis: "auto", grow: 0, shrink: 1, minSize: 0 },
					{ component: this.footerContainer, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
					{ component: this.editorContainer, basis: "auto", grow: 0, shrink: 1, minSize: 3 },
					{ component: this.widgetContainerBelow, basis: "auto", grow: 0, shrink: 1, minSize: 0 },
				]),
			);
		}
		this.ui.setFocus(this.editor);
		this.extensionUI = this.createExtensionUIContext();
	}

	getExtensionUIContext(): ExtensionUIContext {
		return this.extensionUI;
	}

	cancelPendingInteractions(): void {
		this.resolveSelection(undefined);
		this.resolveApproval(false);
	}

	resetExtensionUI(): void {
		this.cancelPendingInteractions();
		for (const unsubscribe of this.extensionTerminalInputUnsubscribers) unsubscribe();
		this.extensionTerminalInputUnsubscribers.clear();
		this.clearExtensionWidgets();
		this.setExtensionHeader(undefined);
		this.setExtensionFooter(undefined);
		this.setEditorComponent(undefined);
		this.extensionStatuses.clear();
		this.ui.terminal.setTitle(`${APP_NAME} Harness Runtime`);
		this.refreshStatus();
	}

	setHandlers(handlers: CodingInteractiveViewHandlers): void {
		this.handlers = handlers;
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.ui.start();
	}

	stop(): void {
		this.resetExtensionUI();
		if (!this.started) return;
		this.started = false;
		this.ui.stop();
	}

	render(snapshot: CodingRuntimeSnapshot): void {
		this.transcript.clear();
		for (const message of snapshot.projection.messages) {
			this.transcript.addChild(new Text(formatProjectedMessage(message), 1, 0));
			this.transcript.addChild(new Spacer(1));
		}
		this.baseStatus = formatRuntimeStatus(snapshot);
		if (!this.pendingApproval) this.refreshStatus();
		this.ui.requestRender();
	}

	renderAgentEvent(event: AgentEvent): void {
		switch (event.type) {
			case "message_start":
			case "message_update":
				if (event.message.role !== "assistant") return;
				this.liveMessage.clear();
				this.liveMessage.addChild(
					new Text(`${theme.bold("Assistant (streaming)")}\n${formatContent(event.message.content)}`, 1, 0),
				);
				break;
			case "message_end":
				if (event.message.role !== "assistant") return;
				this.liveMessage.clear();
				break;
			case "agent_end":
				this.liveMessage.clear();
				break;
			default:
				return;
		}
		this.ui.requestRender();
	}

	showStatus(message: string): void {
		this.baseStatus = theme.fg("muted", message);
		if (!this.pendingApproval) this.refreshStatus();
		this.ui.requestRender();
	}

	showError(message: string): void {
		this.notices.addChild(new Text(theme.fg("error", `Error: ${message}`), 1, 0));
		this.ui.requestRender();
	}

	requestApproval(message: string, signal?: AbortSignal): Promise<boolean> {
		if (signal?.aborted || this.pendingApproval) return Promise.resolve(false);
		this.resolveSelection(undefined);
		return new Promise<boolean>((resolve) => {
			const onAbort = () => this.resolveApproval(false);
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pendingApproval = {
				resolve,
				removeAbortListener: () => signal?.removeEventListener("abort", onAbort),
			};
			this.status.setText(theme.fg("warning", `${message} Type y or yes to allow; any other answer denies.`));
			this.ui.requestRender();
		});
	}

	selectSession(
		sessions: readonly CodingSessionSelectorItem[],
		currentSessionPath: string,
	): Promise<string | undefined> {
		if (sessions.length === 0) return Promise.resolve(undefined);
		return this.showSelector(
			(select, cancel) =>
				new CodingSessionSelectorComponent(sessions, currentSessionPath, this.ui.terminal.rows, select, cancel),
		);
	}

	selectTree(entries: readonly CodingTreeSelectorItem[], currentLeafId: string | null): Promise<string | undefined> {
		if (entries.length === 0) return Promise.resolve(undefined);
		return this.showSelector(
			(select, cancel) =>
				new CodingTreeSelectorComponent(entries, currentLeafId, this.ui.terminal.rows, select, cancel),
		);
	}

	selectThinkingLevel(
		current: ThinkingLevel,
		available: readonly ThinkingLevel[],
	): Promise<ThinkingLevel | undefined> {
		if (available.length === 0) return Promise.resolve(undefined);
		return this.showSelector<ThinkingLevel>(
			(select, cancel) => new ThinkingSelectorComponent(current, [...available], select, cancel),
		);
	}

	async selectModel(models: readonly Model<Api>[], current: Model<Api>): Promise<Model<Api> | undefined> {
		if (models.length === 0) return undefined;
		const selectedKey = await this.showSelector<string>(
			(select, cancel) => new CodingModelSelectorComponent(models, current, this.ui.terminal.rows, select, cancel),
		);
		return models.find((model) => modelKey(model) === selectedKey);
	}

	selectTools(
		tools: readonly CodingToolSelectorItem[],
		activeNames: readonly string[],
	): Promise<string[] | undefined> {
		if (tools.length === 0) return Promise.resolve(undefined);
		return this.showSelector<string[]>(
			(select, cancel) => new CodingToolSelectorComponent(tools, activeNames, this.ui.terminal.rows, select, cancel),
		);
	}

	private createExtensionUIContext(): ExtensionUIContext {
		const fallback = getNoOpExtensionUIContext();
		return {
			...fallback,
			select: (title, options, dialogOptions) => this.selectExtensionOption(title, options, dialogOptions),
			confirm: async (title, message, dialogOptions) =>
				(await this.selectExtensionOption(`${title}\n${message}`, ["Yes", "No"], dialogOptions)) === "Yes",
			input: (title, placeholder, dialogOptions) => this.showExtensionInput(title, placeholder, dialogOptions),
			notify: (message, type) => {
				if (type === "error") this.showError(message);
				else if (type === "warning") {
					this.notices.addChild(new Text(theme.fg("warning", `Warning: ${message}`), 1, 0));
					this.ui.requestRender();
				} else this.showStatus(message);
			},
			onTerminalInput: (handler) => {
				const unsubscribeInput = this.ui.addInputListener(handler);
				const unsubscribe = () => {
					unsubscribeInput();
					this.extensionTerminalInputUnsubscribers.delete(unsubscribe);
				};
				this.extensionTerminalInputUnsubscribers.add(unsubscribe);
				return unsubscribe;
			},
			setStatus: (key, text) => {
				if (text === undefined) this.extensionStatuses.delete(key);
				else this.extensionStatuses.set(key, text);
				this.refreshStatus();
			},
			setTitle: (title) => this.ui.terminal.setTitle(title),
			setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
			setFooter: (factory) => this.setExtensionFooter(factory),
			setHeader: (factory) => this.setExtensionHeader(factory),
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
			setEditorText: (text) => this.editor.setText(text),
			getEditorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
			editor: (title, prefill) => this.showExtensionEditor(title, prefill),
			setEditorComponent: (factory) => this.setEditorComponent(factory),
			getEditorComponent: () => this.editorComponentFactory,
			getAllThemes: () => getAvailableThemesWithPaths(),
			getTheme: (name) => getThemeByName(name),
			setTheme: (themeOrName) => {
				if (typeof themeOrName === "string") {
					const result = applyTheme(themeOrName);
					if (result.success) this.ui.requestRender(true);
					return result;
				}
				setThemeInstance(themeOrName);
				this.ui.requestRender(true);
				return { success: true };
			},
		};
	}

	private selectExtensionOption(
		title: string,
		options: string[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		if (options.length === 0 || dialogOptions?.signal?.aborted) return Promise.resolve(undefined);
		return this.withDialogAbort(
			this.showSelector(
				(select, cancel) =>
					new ExtensionSelectorComponent(title, options, select, cancel, {
						tui: this.ui,
						timeout: dialogOptions?.timeout,
					}),
			),
			dialogOptions?.signal,
		);
	}

	private showExtensionInput(
		title: string,
		placeholder?: string,
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		if (dialogOptions?.signal?.aborted) return Promise.resolve(undefined);
		return this.withDialogAbort(
			this.showSelector(
				(submit, cancel) =>
					new ExtensionInputComponent(title, placeholder, submit, cancel, {
						tui: this.ui,
						timeout: dialogOptions?.timeout,
					}),
			),
			dialogOptions?.signal,
		);
	}

	private showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		return this.showSelector(
			(submit, cancel) => new ExtensionEditorComponent(this.ui, this.keybindings, title, prefill, submit, cancel),
		);
	}

	private setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, extensionTheme: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		this.removeExtensionWidget(this.extensionWidgetsAbove, key);
		this.removeExtensionWidget(this.extensionWidgetsBelow, key);
		if (content !== undefined) {
			let component: Component & { dispose?(): void };
			if (Array.isArray(content)) {
				const container = new Container();
				for (const line of content.slice(0, 10)) container.addChild(new Text(line, 1, 0));
				if (content.length > 10) container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
				component = container;
			} else {
				component = content(this.ui, theme);
			}
			const target = options?.placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
			target.set(key, component);
		}
		this.renderExtensionWidgets();
	}

	private removeExtensionWidget(widgets: Map<string, Component & { dispose?(): void }>, key: string): void {
		widgets.get(key)?.dispose?.();
		widgets.delete(key);
	}

	private clearExtensionWidgets(): void {
		for (const key of [...this.extensionWidgetsAbove.keys()]) {
			this.removeExtensionWidget(this.extensionWidgetsAbove, key);
		}
		for (const key of [...this.extensionWidgetsBelow.keys()]) {
			this.removeExtensionWidget(this.extensionWidgetsBelow, key);
		}
		this.renderExtensionWidgets();
	}

	private renderExtensionWidgets(): void {
		this.widgetContainerAbove.clear();
		this.widgetContainerBelow.clear();
		for (const widget of this.extensionWidgetsAbove.values()) this.widgetContainerAbove.addChild(widget);
		for (const widget of this.extensionWidgetsBelow.values()) this.widgetContainerBelow.addChild(widget);
		this.ui.requestRender();
	}

	private setExtensionHeader(
		factory: ((tui: TUI, extensionTheme: Theme) => Component & { dispose?(): void }) | undefined,
	): void {
		this.customHeader?.dispose?.();
		this.headerContainer.clear();
		this.customHeader = factory?.(this.ui, theme);
		this.headerContainer.addChild(this.customHeader ?? this.builtInHeader);
		this.ui.requestRender();
	}

	private setExtensionFooter(
		factory:
			| ((
					tui: TUI,
					extensionTheme: Theme,
					footerData: ReadonlyFooterDataProvider,
			  ) => Component & { dispose?(): void })
			| undefined,
	): void {
		this.customFooter?.dispose?.();
		this.footerContainer.clear();
		this.customFooter = factory?.(this.ui, theme, {
			getGitBranch: () => null,
			getExtensionStatuses: () => this.extensionStatuses,
			getAvailableProviderCount: () => 0,
			onBranchChange: () => () => undefined,
		});
		this.footerContainer.addChild(this.customFooter ?? this.status);
		this.ui.requestRender();
	}

	private setEditorComponent(factory: EditorFactory | undefined): void {
		this.editorComponentFactory = factory;
		const previous = this.editor;
		const currentText = previous.getText();
		const replacement = factory?.(this.ui, getEditorTheme(), this.keybindings) ?? this.defaultEditor;
		replacement.onSubmit = (input) => this.handleSubmit(input);
		if (replacement instanceof CustomEditor) this.configureCustomEditor(replacement);
		replacement.setText(currentText);
		this.editor = replacement;
		if (previous !== replacement && previous !== this.defaultEditor) {
			(previous as EditorComponent & { dispose?(): void }).dispose?.();
		}
		this.restoreEditorFocus();
	}

	private configureCustomEditor(editor: CustomEditor): void {
		editor.onSubmit = (input) => this.handleSubmit(input);
		editor.onEscape = () => this.handleAbort();
		editor.onCtrlD = () => this.handlers?.exit();
		editor.onAction("app.interrupt", () => this.handleAbort());
		editor.onAction("app.clear", () => this.handleAbort());
	}

	private showExtensionCustom<T>(
		factory: Parameters<ExtensionUIContext["custom"]>[0],
		options?: Parameters<ExtensionUIContext["custom"]>[1],
	): Promise<T> {
		if (this.pendingApproval) return Promise.resolve(undefined as T);
		this.resolveSelection(undefined);
		return new Promise<T>((resolve, reject) => {
			const pending: PendingSelection = {
				dispose: () => undefined,
				resolve: (value) => resolve(value as T),
			};
			this.pendingSelection = pending;
			const done = (value: unknown) => {
				if (this.pendingSelection === pending) this.resolveSelection(value);
			};
			Promise.resolve(factory(this.ui, theme, this.keybindings, done))
				.then((component) => {
					if (this.pendingSelection !== pending) {
						component.dispose?.();
						return;
					}
					if (options?.overlay) {
						const overlayOptions =
							typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
						const handle = this.ui.showOverlay(component, overlayOptions);
						options.onHandle?.(handle);
						pending.dispose = () => {
							this.ui.hideOverlay();
							component.dispose?.();
						};
					} else {
						pending.dispose = () => component.dispose?.();
						this.editorContainer.clear();
						this.editorContainer.addChild(component);
						this.ui.setFocus(component);
					}
					this.ui.requestRender();
				})
				.catch((error: unknown) => {
					if (this.pendingSelection !== pending) return;
					this.pendingSelection = undefined;
					this.restoreEditorFocus();
					reject(error);
				});
		});
	}

	private async withDialogAbort<T>(dialog: Promise<T | undefined>, signal?: AbortSignal): Promise<T | undefined> {
		if (!signal) return dialog;
		const onAbort = () => this.resolveSelection(undefined);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await dialog;
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	private showSelector<T>(
		create: (select: (value: T) => void, cancel: () => void) => Component & { dispose?(): void },
	): Promise<T | undefined> {
		if (this.pendingApproval) return Promise.resolve(undefined);
		this.resolveSelection(undefined);
		return new Promise<T | undefined>((resolve) => {
			const selector = create(
				(value) => this.resolveSelection(value),
				() => this.resolveSelection(undefined),
			);
			this.pendingSelection = {
				dispose: () => selector.dispose?.(),
				resolve: (value) => resolve(value as T | undefined),
			};
			this.editorContainer.clear();
			this.editorContainer.addChild(selector);
			this.ui.setFocus(selector);
			this.ui.requestRender();
		});
	}

	private handleSubmit(input: string): void {
		const value = input.trim();
		if (value.length > 0) this.editor.addToHistory?.(value);
		this.editor.setText("");
		if (this.pendingApproval) {
			this.resolveApproval(value.toLowerCase() === "y" || value.toLowerCase() === "yes");
			return;
		}
		if (value.length > 0) this.handlers?.submit(value);
	}

	private handleAbort(): void {
		if (this.pendingSelection) this.resolveSelection(undefined);
		else if (this.pendingApproval) this.resolveApproval(false);
		else this.handlers?.abort();
	}

	private resolveSelection(value: unknown): void {
		const pending = this.pendingSelection;
		if (!pending) return;
		this.pendingSelection = undefined;
		pending.dispose();
		this.restoreEditorFocus();
		pending.resolve(value);
	}

	private restoreEditorFocus(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	private refreshStatus(): void {
		if (this.pendingApproval) return;
		const extensionStatus = [...this.extensionStatuses]
			.map(([statusKey, statusText]) => `${statusKey}: ${statusText}`)
			.join(" 路 ");
		this.status.setText(
			[this.baseStatus, extensionStatus ? theme.fg("muted", extensionStatus) : ""].filter(Boolean).join(" 路 "),
		);
		this.ui.requestRender();
	}

	private resolveApproval(allowed: boolean): void {
		const pending = this.pendingApproval;
		if (!pending) return;
		this.pendingApproval = undefined;
		pending.removeAbortListener();
		pending.resolve(allowed);
		this.baseStatus = theme.fg("muted", allowed ? "Tool approved" : "Tool denied");
		this.refreshStatus();
	}
}

export interface CodingInteractiveModeOptions {
	view?: CodingInteractiveView;
	viewOptions?: PiCodingInteractiveViewOptions;
	initialInputs?: readonly (string | AgentMessage)[];
	signal?: AbortSignal;
	availableModels?: () => readonly Model<Api>[];
	onModelChanged?: (model: Model<Api>) => void | Promise<void>;
	onThinkingLevelChanged?: (level: ThinkingLevel) => void | Promise<void>;
	onToolsChanged?: (names: readonly string[]) => void | Promise<void>;
}

/** Interactive consumer that delegates every durable operation to CodingRuntimeController. */
export class CodingInteractiveMode {
	readonly view: CodingInteractiveView;
	private readonly host: CodingRuntimeHost;
	private readonly initialInputs: readonly (string | AgentMessage)[];
	private readonly signal?: AbortSignal;
	private readonly availableModels: () => readonly Model<Api>[];
	private readonly onModelChanged?: (model: Model<Api>) => void | Promise<void>;
	private readonly onThinkingLevelChanged?: (level: ThinkingLevel) => void | Promise<void>;
	private readonly onToolsChanged?: (names: readonly string[]) => void | Promise<void>;
	private readonly tasks = new Set<Promise<void>>();
	private startupTask: Promise<void> = Promise.resolve();
	private finish: () => void = () => undefined;
	private readonly finished: Promise<void>;
	private running = false;
	private exitRequested = false;

	constructor(host: CodingRuntimeHost, options: CodingInteractiveModeOptions = {}) {
		this.host = host;
		this.view = options.view ?? new PiCodingInteractiveView(options.viewOptions);
		this.initialInputs = options.initialInputs ?? [];
		this.signal = options.signal;
		this.availableModels = options.availableModels ?? (() => [this.host.controller.driver.model as Model<Api>]);
		this.onModelChanged = options.onModelChanged;
		this.onThinkingLevelChanged = options.onThinkingLevelChanged;
		this.onToolsChanged = options.onToolsChanged;
		this.finished = new Promise<void>((resolve) => {
			this.finish = resolve;
		});
	}

	async run(): Promise<number> {
		if (this.running) throw new Error("Coding interactive mode is already running");
		this.running = true;
		this.view.setHandlers({
			submit: (input) => this.schedule(() => this.handleInput(input)),
			abort: () => this.host.controller.abort(),
			exit: () => this.requestExit(),
		});
		this.view.render(this.host.snapshot);
		const unsubscribe = this.host.subscribe((snapshot) => this.view.render(snapshot), false);
		const unsubscribeAgentEvents = this.host.onAgentEvent((event) => this.view.renderAgentEvent(event));
		const onAbort = () => this.requestExit();
		this.signal?.addEventListener("abort", onAbort, { once: true });
		if (this.signal?.aborted) this.requestExit();
		this.view.start();
		this.startupTask = this.exitRequested ? Promise.resolve() : this.sendInitialInputs();

		try {
			await this.startupTask;
			await this.finished;
			await this.settle();
			this.host.controller.abort();
			await this.host.controller.waitForIdle();
			return 0;
		} finally {
			unsubscribe();
			unsubscribeAgentEvents();
			this.signal?.removeEventListener("abort", onAbort);
			this.view.stop();
			await this.host.dispose();
		}
	}

	stop(): void {
		this.requestExit();
	}

	async settle(): Promise<void> {
		await this.startupTask;
		while (this.tasks.size > 0) await Promise.all([...this.tasks]);
		await this.host.controller.projection.settle();
	}

	private async sendInitialInputs(): Promise<void> {
		for (const input of this.initialInputs) {
			if (typeof input === "string" && input.trim().length === 0) continue;
			try {
				await this.host.controller.send(input, "prompt");
			} catch (error) {
				this.view.showError(error instanceof Error ? error.message : String(error));
			}
		}
	}

	private schedule(action: () => Promise<void>): void {
		const task = action()
			.catch((error) => this.view.showError(error instanceof Error ? error.message : String(error)))
			.finally(() => this.tasks.delete(task));
		this.tasks.add(task);
	}

	private async handleInput(input: string): Promise<void> {
		const command = parseInteractiveCommand(input);
		if (!command) {
			await this.host.controller.send(input, "auto");
			return;
		}
		switch (command.name) {
			case "quit":
			case "exit":
				this.requestExit();
				return;
			case "abort":
				this.host.controller.abort();
				return;
			case "resume":
				await this.host.controller.resume();
				return;
			case "compact":
				await this.host.controller.compact(command.args || undefined);
				return;
			case "export": {
				const path = await this.host.controller.exportHtml(command.args.trim() || undefined);
				this.view.showStatus(`Exported Session to ${path}`);
				return;
			}
			case "name":
				await this.host.controller.setSessionName(command.args || undefined);
				return;
			case "new": {
				const id = command.args.trim() || undefined;
				const { sessionId } = await this.host.newSession(id ? { id } : undefined);
				this.view.showStatus(`Started new Session ${sessionId}`);
				return;
			}
			case "reload": {
				const { sessionId } = await this.host.reload();
				this.view.showStatus(`Reloaded Session ${sessionId}`);
				return;
			}
			case "session": {
				if (command.args.trim()) {
					const current = this.host.snapshot.session;
					const selected = resolveInteractiveSession(
						command.args.trim(),
						await this.host.controller.listSessions("all"),
						current.cwd,
					);
					if (selected.id === current.id && selected.cwd === current.cwd) {
						this.view.showStatus("Already using this Session");
						return;
					}
					await this.host.switchSession({ sessionId: selected.id, cwd: selected.cwd });
					this.view.showStatus(`Switched to Session ${selected.id} · ${selected.cwd}`);
					return;
				}
				const { session } = this.host.snapshot;
				this.view.showStatus(
					`${session.name ? `${session.name} · ` : ""}${session.id} · ${session.cwd} · ${session.path}`,
				);
				return;
			}
			case "sessions": {
				const controller = this.host.controller;
				if (!controller.isIdle) throw new Error("Cannot switch Sessions while the Runtime is active");
				const recovery = await controller.getRecoveryState();
				if (recovery.status !== "idle") {
					throw new Error(`Cannot switch Sessions while recovery status is ${recovery.status}`);
				}
				const requestedScope = command.args.trim();
				if (requestedScope && requestedScope !== "current" && requestedScope !== "all") {
					throw new Error("Usage: /sessions [current|all]");
				}
				const currentSession = this.host.snapshot.session;
				const sessions = await controller.listSessions(requestedScope === "all" ? "all" : "current");
				const selected = await this.view.selectSession(
					sessions.map(({ id, cwd, path, createdAt, modifiedAt, parentSessionId }) => ({
						id,
						cwd,
						path,
						createdAt,
						modifiedAt,
						...(parentSessionId === undefined ? {} : { parentSessionId }),
					})),
					currentSession.path,
				);
				if (!selected) return;
				if (resolve(selected) === resolve(currentSession.path)) {
					this.view.showStatus("Already using this Session");
					return;
				}
				const metadata = sessions.find(({ path }) => resolve(path) === resolve(selected));
				if (!metadata) throw new Error(`Selected Session is no longer available: ${selected}`);
				await this.host.switchSession({ sessionId: metadata.id, cwd: metadata.cwd });
				this.view.showStatus(`Switched to Session ${metadata.id} · ${metadata.cwd}`);
				return;
			}
			case "tree": {
				const controller = this.host.controller;
				const navigation = parseTreeNavigation(command.args);
				if (!controller.isIdle) throw new Error("Cannot navigate the Session tree while the Runtime is active");
				const recovery = await controller.getRecoveryState();
				if (recovery.status !== "idle") {
					throw new Error(`Cannot navigate the Session tree while recovery status is ${recovery.status}`);
				}
				const { entries, lanes } = await controller.getTree();
				if (entries.length === 0) {
					this.view.showStatus("No entries in this Session");
					return;
				}
				const currentLeafId = lanes.find(({ lane }) => lane === "main")?.leafId ?? null;
				const selected = await this.view.selectTree(
					entries.map((entry) => ({
						id: entry.id,
						parentId: entry.parentId,
						seq: entry.seq,
						type: entry.type,
						text: formatTreeEntry(entry),
					})),
					currentLeafId,
				);
				if (!selected) return;
				if (selected === currentLeafId) {
					this.view.showStatus("Already at this Session entry");
					return;
				}
				await controller.navigateTo(selected, navigation);
				this.view.showStatus(
					navigation.summarize
						? `Navigated to entry ${selected} with branch summary`
						: `Navigated to entry ${selected}`,
				);
				return;
			}
			case "fork": {
				const id = command.args.trim() || undefined;
				const { metadata } = await this.host.forkAndSwitch(id ? { id } : undefined);
				this.view.showStatus(`Forked and switched to Session ${metadata.id}`);
				return;
			}
			case "thinking": {
				const controller = this.host.controller;
				if (!controller.isIdle) throw new Error("Cannot change thinking level while the Runtime is active");
				const available = getSupportedThinkingLevels(controller.driver.model) as ThinkingLevel[];
				const requested = command.args.trim();
				if (requested && !available.includes(requested as ThinkingLevel)) {
					throw new Error(`Unsupported thinking level: ${requested}; available: ${available.join(", ")}`);
				}
				const selected = requested
					? (requested as ThinkingLevel)
					: await this.view.selectThinkingLevel(this.host.snapshot.thinkingLevel, available);
				if (!selected) return;
				await controller.setThinkingLevel(selected);
				await this.onThinkingLevelChanged?.(selected);
				this.view.showStatus(`Thinking level: ${selected}`);
				return;
			}
			case "model": {
				const controller = this.host.controller;
				if (!controller.isIdle) throw new Error("Cannot change model while the Runtime is active");
				const models = uniqueModels([...this.availableModels(), controller.driver.model as Model<Api>]);
				const selected = command.args.trim()
					? resolveInteractiveModel(command.args.trim(), models)
					: await this.view.selectModel(models, controller.driver.model as Model<Api>);
				if (!selected) return;
				await controller.setModel(selected);
				await this.onModelChanged?.(selected);
				this.view.showStatus(`Model: ${selected.provider}/${selected.id}`);
				return;
			}
			case "tools": {
				const controller = this.host.controller;
				if (!controller.isIdle) throw new Error("Cannot change tools while the Runtime is active");
				const available = controller.availableTools;
				const selected = command.args.trim()
					? resolveInteractiveTools(command.args.trim(), available)
					: await this.view.selectTools(available, this.host.snapshot.toolNames);
				if (!selected) return;
				await controller.setActiveTools(selected);
				await this.onToolsChanged?.(selected);
				this.view.showStatus(`Tools: ${selected.join(", ") || "none"}`);
				return;
			}
			case "help":
				this.view.showStatus(
					"Commands: /resume, /abort, /compact [instructions], /export [path], /name [name], /new [id], /reload, /session [id|path], /sessions [current|all], /tree [summarize [instructions]], /fork [id], /thinking [level], /model [provider/id], /tools [names|all|none], /quit; Extension commands are also available.",
				);
				return;
		}
		const extensionCommand = this.host.controller.commands.find((candidate) => candidate.name === command.name);
		if (!extensionCommand) throw new Error(`Unknown command: /${command.name}`);
		await this.host.controller.invokeCommand(extensionCommand.name, command.args);
	}

	private requestExit(): void {
		if (this.exitRequested) return;
		this.exitRequested = true;
		this.host.controller.abort();
		this.finish();
	}
}

function uniqueModels(models: readonly Model<Api>[]): Model<Api>[] {
	const unique = new Map<string, Model<Api>>();
	for (const model of models) unique.set(modelKey(model), model);
	return [...unique.values()];
}

function resolveInteractiveModel(input: string, models: readonly Model<Api>[]): Model<Api> {
	const slash = input.indexOf("/");
	const matches =
		slash > 0
			? models.filter((model) => model.provider === input.slice(0, slash) && model.id === input.slice(slash + 1))
			: models.filter((model) => model.id === input);
	if (matches.length === 1) return matches[0]!;
	if (matches.length > 1) throw new Error(`Model id is ambiguous; use provider/id: ${input}`);
	throw new Error(`Unknown model: ${input}`);
}

function resolveInteractiveTools(input: string, available: readonly CodingRuntimeToolInfo[]): string[] {
	if (input === "none") return [];
	if (input === "all") return available.map(({ name }) => name);
	const names = [...new Set(input.split(/[\s,]+/u).filter(Boolean))];
	const availableNames = new Set(available.map(({ name }) => name));
	const unknown = names.filter((name) => !availableNames.has(name));
	if (unknown.length > 0) throw new Error(`Unknown tool(s): ${unknown.join(", ")}`);
	return names;
}

function resolveInteractiveSession(
	input: string,
	sessions: readonly JsonlSessionMetadata[],
	baseCwd: string,
): JsonlSessionMetadata {
	const resolvedInput = resolve(baseCwd, input);
	const matches = sessions.filter(({ id, path }) => id === input || resolve(path) === resolvedInput);
	if (matches.length === 1) return matches[0]!;
	if (matches.length > 1) throw new Error(`Session id is ambiguous across projects; use its JSONL path: ${input}`);
	throw new Error(`Unknown Session id or path: ${input}`);
}

function parseTreeNavigation(input: string): { summarize?: boolean; customInstructions?: string } {
	const trimmed = input.trim();
	if (!trimmed) return {};
	const match = /^summarize(?:\s+([\s\S]+))?$/u.exec(trimmed);
	if (!match) throw new Error("Usage: /tree [summarize [instructions]]");
	return { summarize: true, ...(match[1] === undefined ? {} : { customInstructions: match[1] }) };
}

function parseInteractiveCommand(input: string): { name: string; args: string } | undefined {
	if (!input.startsWith("/")) return undefined;
	const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(input.trim());
	return match ? { name: match[1]!, args: match[2] ?? "" } : undefined;
}

function formatRuntimeStatus(snapshot: CodingRuntimeSnapshot): string {
	const activity = snapshot.projection.turnState.operation ? "running" : snapshot.recovery.status;
	return theme.fg(
		"muted",
		`${snapshot.session.name ?? snapshot.session.id} · ${snapshot.model.provider}/${snapshot.model.id} · thinking ${snapshot.thinkingLevel} · ${activity}`,
	);
}

function formatProjectedMessage(message: AgentMessage): string {
	switch (message.role) {
		case "user":
			return `${theme.bold("You")}\n${formatContent(message.content)}`;
		case "assistant":
			return `${theme.bold("Assistant")}\n${formatContent(message.content)}`;
		case "toolResult":
			return `${theme.bold(`Tool ${message.toolName}${message.isError ? " failed" : ""}`)}\n${formatContent(message.content)}`;
		case "bashExecution":
			return `${theme.bold("Bash")} ${message.command}\n${message.output}`;
		case "custom":
			return `${theme.bold(message.customType)}\n${formatContent(message.content)}`;
		case "branchSummary":
			return `${theme.bold("Branch summary")}\n${message.summary}`;
		case "compactionSummary":
			return `${theme.bold("Compaction summary")}\n${message.summary}`;
	}
}

function formatContent(content: string | readonly unknown[]): string {
	if (typeof content === "string") return content;
	return content
		.map(formatContentPart)
		.filter((part) => part.length > 0)
		.join("\n");
}

function formatContentPart(part: unknown): string {
	if (!part || typeof part !== "object" || !("type" in part)) return String(part);
	if (part.type === "text" && "text" in part && typeof part.text === "string") return part.text;
	if (part.type === "thinking" && "thinking" in part && typeof part.thinking === "string") {
		return `Thinking: ${part.thinking}`;
	}
	if (part.type === "toolCall" && "name" in part && typeof part.name === "string") {
		const args = "arguments" in part ? JSON.stringify(part.arguments) : "";
		return `Tool call: ${part.name}${args ? ` ${args}` : ""}`;
	}
	if (part.type === "image" && "mimeType" in part && typeof part.mimeType === "string") {
		return `[image ${part.mimeType}]`;
	}
	return "";
}

function formatTreeEntry(entry: Entry): string {
	switch (entry.type) {
		case "message":
			return formatTreeMessage(entry.message);
		case "model_change":
			return `${entry.provider}/${entry.modelId}`;
		case "thinking_level_change":
			return entry.thinkingLevel;
		case "active_tools_change":
			return entry.activeToolNames.join(", ");
		case "compaction":
		case "branch_summary":
			return entry.summary.replace(/\s+/gu, " ").trim();
		case "custom":
			return entry.customType;
	}
}

function formatTreeMessage(message: AgentMessage): string {
	let text: string;
	switch (message.role) {
		case "user":
		case "assistant":
		case "toolResult":
		case "custom":
			text = formatContent(message.content);
			break;
		case "bashExecution":
			text = `${message.command} ${message.output}`;
			break;
		case "branchSummary":
		case "compactionSummary":
			text = message.summary;
			break;
	}
	return `${message.role}: ${text.replace(/\s+/gu, " ").trim()}`;
}
