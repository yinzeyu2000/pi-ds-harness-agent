export interface PromptContributor {
	id: string;
	priority?: number;
	contribute(): string | undefined | Promise<string | undefined>;
}

interface StoredPromptContributor {
	contributor: PromptContributor;
	order: number;
}

export interface PromptView {
	text: string;
	contributorIds: readonly string[];
}

export class PromptContributorConflictError extends Error {
	readonly contributorId: string;

	constructor(contributorId: string) {
		super(`Prompt contributor is already registered in this catalog: ${contributorId}`);
		this.name = "PromptContributorConflictError";
		this.contributorId = contributorId;
	}
}

export class PromptCatalog {
	private readonly basePrompt: string;
	private readonly contributors = new Map<string, StoredPromptContributor>();
	private nextOrder = 0;

	constructor(basePrompt: string) {
		this.basePrompt = basePrompt;
	}

	register(contributor: PromptContributor): () => void {
		if (this.contributors.has(contributor.id)) throw new PromptContributorConflictError(contributor.id);
		const stored = { contributor, order: this.nextOrder++ };
		this.contributors.set(contributor.id, stored);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			if (this.contributors.get(contributor.id) === stored) this.contributors.delete(contributor.id);
		};
	}

	async render(): Promise<PromptView> {
		const sections = this.basePrompt.length > 0 ? [this.basePrompt] : [];
		const contributorIds: string[] = [];
		const ordered = [...this.contributors.values()].sort(
			(left, right) =>
				(left.contributor.priority ?? 0) - (right.contributor.priority ?? 0) || left.order - right.order,
		);
		for (const { contributor } of ordered) {
			const section = await contributor.contribute();
			if (section === undefined || section.length === 0) continue;
			sections.push(section);
			contributorIds.push(contributor.id);
		}
		return Object.freeze({ text: sections.join("\n\n"), contributorIds: Object.freeze(contributorIds) });
	}

	get size(): number {
		return this.contributors.size;
	}
}
