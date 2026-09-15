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

export interface CodingToolSelectorItem {
	name: string;
	description: string;
}

const APPLY = "action:apply";
const ENABLE_ALL = "action:all";
const DISABLE_ALL = "action:none";
const TOOL_PREFIX = "tool:";

/** Multi-select editor over tools registered in the active Harness Tool Catalog. */
export class CodingToolSelectorComponent extends Container implements Focusable {
	private readonly tools: readonly CodingToolSelectorItem[];
	private readonly selected = new Set<string>();
	private readonly searchInput = new Input();
	private selectList: SelectList;
	private readonly selectListIndex: number;
	private readonly maxVisible: number;
	private readonly onSelect: (names: string[]) => void;
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
		tools: readonly CodingToolSelectorItem[],
		activeNames: readonly string[],
		terminalHeight: number,
		onSelect: (names: string[]) => void,
		onCancel: () => void,
	) {
		super();
		this.tools = tools;
		for (const name of activeNames) this.selected.add(name);
		this.maxVisible = Math.max(4, Math.floor(terminalHeight / 2));
		this.onSelect = onSelect;
		this.onCancel = onCancel;

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold("  Harness Tools"), 1, 0));
		this.addChild(new Text(theme.fg("muted", "  Select a tool to toggle it, then choose Apply selection"), 1, 0));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.selectList = this.buildSelectList([...tools], APPLY);
		this.selectListIndex = this.children.length;
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to activate · Esc to cancel"), 1, 0));
		this.addChild(new DynamicBorder());

		this.searchInput.onSubmit = () => this.selectList.handleInput("\r");
	}

	handleInput(keyData: string): void {
		const keybindings = getKeybindings();
		if (
			keybindings.matches(keyData, "tui.select.up") ||
			keybindings.matches(keyData, "tui.select.down") ||
			keybindings.matches(keyData, "tui.select.cancel")
		) {
			this.selectList.handleInput(keyData);
			return;
		}
		if (keybindings.matches(keyData, "tui.select.confirm")) {
			this.activate(this.selectList.getSelectedItem()?.value);
			return;
		}
		this.searchInput.handleInput(keyData);
		this.applyFilter(this.searchInput.getValue());
	}

	private activate(value: string | undefined): void {
		if (!value) return;
		if (value === APPLY) {
			this.onSelect(this.tools.map(({ name }) => name).filter((name) => this.selected.has(name)));
			return;
		}
		if (value === ENABLE_ALL) {
			for (const { name } of this.tools) this.selected.add(name);
		} else if (value === DISABLE_ALL) {
			this.selected.clear();
		} else if (value.startsWith(TOOL_PREFIX)) {
			const name = value.slice(TOOL_PREFIX.length);
			if (this.selected.has(name)) this.selected.delete(name);
			else this.selected.add(name);
		}
		this.applyFilter(this.searchInput.getValue(), value);
	}

	private applyFilter(query: string, selectedValue?: string): void {
		const previous = selectedValue ?? this.selectList.getSelectedItem()?.value;
		const tools = query
			? fuzzyFilter([...this.tools], query, (tool) => `${tool.name} ${tool.description}`)
			: [...this.tools];
		const replacement = this.buildSelectList(tools, previous);
		this.children[this.selectListIndex] = replacement;
		this.selectList = replacement;
	}

	private buildSelectList(tools: readonly CodingToolSelectorItem[], selectedValue?: string): SelectList {
		const items: SelectItem[] = [
			{ value: APPLY, label: "  Apply selection", description: `${this.selected.size} active` },
			{ value: ENABLE_ALL, label: "  Enable all", description: `${this.tools.length} available` },
			{ value: DISABLE_ALL, label: "  Disable all", description: "No active tools" },
			...tools.map(({ name, description }) => ({
				value: `${TOOL_PREFIX}${name}`,
				label: `${this.selected.has(name) ? "✓ " : "  "}${name}`,
				description,
			})),
		];
		const list = new SelectList(items, this.maxVisible, getSelectListTheme(), {
			minPrimaryColumnWidth: 18,
			maxPrimaryColumnWidth: 40,
		});
		const selectedIndex = items.findIndex((item) => item.value === selectedValue);
		if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
		list.onSelect = (item) => this.activate(item.value);
		list.onCancel = this.onCancel;
		return list;
	}
}
