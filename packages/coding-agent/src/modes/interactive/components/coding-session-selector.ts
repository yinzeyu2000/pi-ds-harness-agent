import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

export interface CodingSessionSelectorItem {
	id: string;
	cwd: string;
	path: string;
	createdAt: number;
	modifiedAt: number;
	parentSessionId?: string;
}

/** Searchable selector over canonical JSONL Session metadata. */
export class CodingSessionSelectorComponent extends Container implements Focusable {
	private readonly sessions: readonly CodingSessionSelectorItem[];
	private readonly currentSessionPath: string;
	private readonly searchInput = new Input();
	private selectList: SelectList;
	private readonly selectListIndex: number;
	private readonly maxVisible: number;
	private readonly onSelect: (sessionId: string) => void;
	private readonly onCancel: () => void;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		sessions: readonly CodingSessionSelectorItem[],
		currentSessionPath: string,
		terminalHeight: number,
		onSelect: (sessionId: string) => void,
		onCancel: () => void,
	) {
		super();
		this.sessions = sessions;
		this.currentSessionPath = currentSessionPath;
		this.maxVisible = Math.max(3, Math.floor(terminalHeight / 2));
		this.onSelect = onSelect;
		this.onCancel = onCancel;

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold("  Harness Sessions"), 1, 0));
		this.addChild(new Text(theme.fg("muted", "  Search by id, path, cwd, or parent session"), 1, 0));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.selectList = this.buildSelectList([...sessions], currentSessionPath);
		this.selectListIndex = this.children.length;
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to switch · Esc to cancel"), 1, 0));
		this.addChild(new DynamicBorder());

		this.searchInput.onSubmit = () => this.selectList.handleInput("\r");
	}

	handleInput(keyData: string): void {
		const keybindings = getKeybindings();
		if (
			keybindings.matches(keyData, "tui.select.up") ||
			keybindings.matches(keyData, "tui.select.down") ||
			keybindings.matches(keyData, "tui.select.confirm") ||
			keybindings.matches(keyData, "tui.select.cancel")
		) {
			this.selectList.handleInput(keyData);
			return;
		}
		this.searchInput.handleInput(keyData);
		this.applyFilter(this.searchInput.getValue());
	}

	private applyFilter(query: string): void {
		const selectedId = this.selectList.getSelectedItem()?.value;
		const sessions = query
			? fuzzyFilter([...this.sessions], query, (session) =>
					[session.id, session.cwd, session.path, session.parentSessionId ?? ""].join(" "),
				)
			: [...this.sessions];
		const replacement = this.buildSelectList(sessions, selectedId);
		this.children[this.selectListIndex] = replacement;
		this.selectList = replacement;
	}

	private buildSelectList(sessions: readonly CodingSessionSelectorItem[], selectedPath?: string): SelectList {
		const items = sessions.map((session) => this.toSelectItem(session));
		const list = new SelectList(items, this.maxVisible, getSelectListTheme(), {
			minPrimaryColumnWidth: 18,
			maxPrimaryColumnWidth: 42,
		});
		const selectedIndex = items.findIndex((item) => item.value === selectedPath);
		if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
		list.onSelect = (item) => this.onSelect(item.value);
		list.onCancel = this.onCancel;
		return list;
	}

	private toSelectItem(session: CodingSessionSelectorItem): SelectItem {
		const parent = session.parentSessionId ? ` · parent ${session.parentSessionId}` : "";
		return {
			value: session.path,
			label: `${session.path === this.currentSessionPath ? "✓ " : "  "}${session.id}`,
			description: `${new Date(session.modifiedAt).toISOString()} · ${session.cwd}${parent}`,
		};
	}
}
