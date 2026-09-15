import type { Api, Model } from "@earendil-works/pi-ai";
import { modelsAreEqual } from "@earendil-works/pi-ai";
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

/** Searchable selector over the authenticated model catalog supplied by the product runtime. */
export class CodingModelSelectorComponent extends Container implements Focusable {
	private readonly models: readonly Model<Api>[];
	private readonly currentModel: Model<Api>;
	private readonly searchInput = new Input();
	private selectList: SelectList;
	private readonly selectListIndex: number;
	private readonly maxVisible: number;
	private readonly onSelect: (key: string) => void;
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
		models: readonly Model<Api>[],
		currentModel: Model<Api>,
		terminalHeight: number,
		onSelect: (key: string) => void,
		onCancel: () => void,
	) {
		super();
		this.models = models;
		this.currentModel = currentModel;
		this.maxVisible = Math.max(3, Math.floor(terminalHeight / 2));
		this.onSelect = onSelect;
		this.onCancel = onCancel;

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold("  Harness Models"), 1, 0));
		this.addChild(new Text(theme.fg("muted", "  Search by provider, id, or model name"), 1, 0));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.selectList = this.buildSelectList([...models], modelKey(currentModel));
		this.selectListIndex = this.children.length;
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to cancel"), 1, 0));
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
		const selectedKey = this.selectList.getSelectedItem()?.value;
		const models = query
			? fuzzyFilter([...this.models], query, (model) => `${model.provider} ${model.id} ${model.name}`)
			: [...this.models];
		const replacement = this.buildSelectList(models, selectedKey);
		this.children[this.selectListIndex] = replacement;
		this.selectList = replacement;
	}

	private buildSelectList(models: readonly Model<Api>[], selectedKey?: string): SelectList {
		const items = models.map((model) => this.toSelectItem(model));
		const list = new SelectList(items, this.maxVisible, getSelectListTheme(), {
			minPrimaryColumnWidth: 18,
			maxPrimaryColumnWidth: 48,
		});
		const selectedIndex = items.findIndex((item) => item.value === selectedKey);
		if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
		list.onSelect = (item) => this.onSelect(item.value);
		list.onCancel = this.onCancel;
		return list;
	}

	private toSelectItem(model: Model<Api>): SelectItem {
		return {
			value: modelKey(model),
			label: `${modelsAreEqual(model, this.currentModel) ? "✓ " : "  "}${model.id}`,
			description: `${model.provider} · ${model.name}`,
		};
	}
}

export function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}\0${model.id}`;
}
