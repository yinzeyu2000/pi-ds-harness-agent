export interface ProjectionDefinition<TFact, TState> {
	id: string;
	initial(): TState;
	reduce(state: TState, fact: TFact): TState;
}

export class ProjectionRegistry<TFact> {
	private readonly definitions = new Map<string, ProjectionDefinition<TFact, unknown>>();

	register<TState>(definition: ProjectionDefinition<TFact, TState>): () => void {
		if (this.definitions.has(definition.id)) throw new Error(`Projection already registered: ${definition.id}`);
		this.definitions.set(definition.id, definition as ProjectionDefinition<TFact, unknown>);
		return () => {
			if (this.definitions.get(definition.id) === definition) this.definitions.delete(definition.id);
		};
	}

	replay<TState>(id: string, facts: readonly TFact[]): TState {
		const definition = this.definitions.get(id);
		if (!definition) throw new Error(`Projection is not registered: ${id}`);
		let state = definition.initial();
		for (const fact of facts) state = definition.reduce(state, fact);
		return structuredClone(state) as TState;
	}

	get size(): number {
		return this.definitions.size;
	}
}

export interface DurableFactStore<TFact> {
	append(fact: TFact): Promise<TFact>;
	readAll(): Promise<TFact[]>;
	flush(): Promise<void>;
}

export class ObservableFactLog<TFact> {
	private readonly observers = new Set<(fact: TFact) => void | Promise<void>>();
	private readonly store: DurableFactStore<TFact>;

	constructor(store: DurableFactStore<TFact>) {
		this.store = store;
	}

	async append(fact: TFact): Promise<TFact> {
		const detached = structuredClone(fact);
		const committed = structuredClone(await this.store.append(detached));
		Object.freeze(committed);
		for (const observer of [...this.observers]) await observer(committed);
		return committed;
	}

	observe(observer: (fact: TFact) => void | Promise<void>): () => void {
		this.observers.add(observer);
		return () => this.observers.delete(observer);
	}

	readAll(): Promise<TFact[]> {
		return this.store.readAll();
	}

	flush(): Promise<void> {
		return this.store.flush();
	}
}

export class MemoryFactStore<TFact> implements DurableFactStore<TFact> {
	private readonly facts: TFact[] = [];

	async append(fact: TFact): Promise<TFact> {
		const committed = structuredClone(fact);
		this.facts.push(committed);
		return structuredClone(committed);
	}

	async readAll(): Promise<TFact[]> {
		return structuredClone(this.facts);
	}

	async flush(): Promise<void> {}
}
