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

export interface CodingTreeSelectorItem {
	id: string;
	parentId: string | null;
	seq: number;
	type: string;
	text: string;
}

type FlatTreeItem = {
	item: CodingTreeSelectorItem;
	depth: number;
};

/** Searchable tree selector over canonical Session entries. */
export class CodingTreeSelectorComponent extends Container implements Focusable {
	private readonly tree: readonly FlatTreeItem[];
	private readonly currentLeafId: string | null;
	private readonly activePath: ReadonlySet<string>;
	private readonly searchInput = new Input();
	private selectList: SelectList;
	private readonly selectListIndex: number;
	private readonly maxVisible: number;
	private readonly onSelect: (entryId: string) => void;
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
		entries: readonly CodingTreeSelectorItem[],
		currentLeafId: string | null,
		terminalHeight: number,
		onSelect: (entryId: string) => void,
		onCancel: () => void,
	) {
		super();
		this.tree = flattenTree(entries);
		this.currentLeafId = currentLeafId;
		this.activePath = buildActivePath(entries, currentLeafId);
		this.maxVisible = Math.max(5, Math.floor(terminalHeight / 2));
		this.onSelect = onSelect;
		this.onCancel = onCancel;

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold("  Harness Session Tree"), 1, 0));
		this.addChild(new Text(theme.fg("muted", "  Search by entry type, id, or content"), 1, 0));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.selectList = this.buildSelectList(this.tree, currentLeafId ?? undefined);
		this.selectListIndex = this.children.length;
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to navigate · Esc to cancel"), 1, 0));
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
		const tree = query
			? fuzzyFilter([...this.tree], query, ({ item }) => `${item.type} ${item.id} ${item.text}`)
			: [...this.tree];
		const replacement = this.buildSelectList(tree, selectedId);
		this.children[this.selectListIndex] = replacement;
		this.selectList = replacement;
	}

	private buildSelectList(tree: readonly FlatTreeItem[], selectedId?: string): SelectList {
		const items = tree.map(({ item, depth }) => this.toSelectItem(item, depth));
		const list = new SelectList(items, this.maxVisible, getSelectListTheme(), {
			minPrimaryColumnWidth: 24,
			maxPrimaryColumnWidth: 52,
		});
		const selectedIndex = items.findIndex((item) => item.value === selectedId);
		if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
		list.onSelect = (item) => this.onSelect(item.value);
		list.onCancel = this.onCancel;
		return list;
	}

	private toSelectItem(item: CodingTreeSelectorItem, depth: number): SelectItem {
		const marker = item.id === this.currentLeafId ? "●" : this.activePath.has(item.id) ? "│" : "·";
		return {
			value: item.id,
			label: `${"  ".repeat(depth)}${marker} ${item.type} #${item.seq}`,
			description: item.text || item.id,
		};
	}
}

function flattenTree(entries: readonly CodingTreeSelectorItem[]): FlatTreeItem[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const children = new Map<string | null, CodingTreeSelectorItem[]>();
	for (const entry of entries) {
		const parentId =
			entry.parentId && entry.parentId !== entry.id && byId.has(entry.parentId) ? entry.parentId : null;
		const siblings = children.get(parentId) ?? [];
		siblings.push(entry);
		children.set(parentId, siblings);
	}
	for (const siblings of children.values()) siblings.sort((left, right) => left.seq - right.seq);

	const flattened: FlatTreeItem[] = [];
	const visited = new Set<string>();
	const pending = [...(children.get(null) ?? [])].reverse().map((item) => ({ item, depth: 0 }));
	while (pending.length > 0) {
		const next = pending.pop()!;
		if (visited.has(next.item.id)) continue;
		visited.add(next.item.id);
		flattened.push(next);
		for (const child of [...(children.get(next.item.id) ?? [])].reverse()) {
			pending.push({ item: child, depth: next.depth + 1 });
		}
	}
	for (const entry of entries) {
		if (!visited.has(entry.id)) flattened.push({ item: entry, depth: 0 });
	}
	return flattened;
}

function buildActivePath(
	entries: readonly CodingTreeSelectorItem[],
	currentLeafId: string | null,
): ReadonlySet<string> {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const path = new Set<string>();
	let currentId = currentLeafId;
	while (currentId && !path.has(currentId)) {
		path.add(currentId);
		currentId = byId.get(currentId)?.parentId ?? null;
	}
	return path;
}
