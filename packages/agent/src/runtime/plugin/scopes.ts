import { EffectScope } from "./effect-scope.ts";
import { ServiceScope } from "./service-scope.ts";

export type ScopeKind = "runtime" | "thread" | "turn" | "task";

export class HierarchicalScope {
	readonly id: string;
	readonly kind: ScopeKind;
	readonly parent?: HierarchicalScope;
	readonly serviceScope: ServiceScope;
	readonly effectScope: EffectScope;
	private childScopes: HierarchicalScope[] = [];
	private isDisposed = false;

	constructor(kind: ScopeKind, id: string, parent?: HierarchicalScope) {
		this.kind = kind;
		this.id = id;
		this.parent = parent;
		this.serviceScope = parent ? parent.serviceScope.createChild(id) : new ServiceScope(id);
		this.effectScope = new EffectScope();
	}

	get disposed(): boolean {
		return this.isDisposed;
	}

	get children(): readonly HierarchicalScope[] {
		return [...this.childScopes];
	}

	createChild(kind: ScopeKind, id: string): HierarchicalScope {
		if (this.isDisposed) {
			throw new Error(`Cannot create child scope on disposed scope: ${this.id}`);
		}
		const child = new HierarchicalScope(kind, id, this);
		this.childScopes.push(child);
		return child;
	}

	removeChild(child: HierarchicalScope): void {
		const index = this.childScopes.indexOf(child);
		if (index !== -1) {
			this.childScopes.splice(index, 1);
		}
	}

	async dispose(): Promise<void> {
		if (this.isDisposed) return;
		this.isDisposed = true;

		const errors: unknown[] = [];

		// Dispose child scopes in reverse LIFO order
		while (this.childScopes.length > 0) {
			const child = this.childScopes.pop()!;
			try {
				await child.dispose();
			} catch (err) {
				errors.push(err);
			}
		}

		// Dispose own effects
		try {
			await this.effectScope.dispose();
		} catch (err) {
			errors.push(err);
		}

		if (this.parent) {
			this.parent.removeChild(this);
		}

		if (errors.length > 0) {
			if (errors.length === 1) {
				throw errors[0];
			}
			throw new AggregateError(errors, `Errors occurred while disposing scope ${this.id}`);
		}
	}
}

export function createRuntimeScope(id = "scope_runtime"): HierarchicalScope {
	return new HierarchicalScope("runtime", id);
}

export function createThreadScope(parent: HierarchicalScope, threadId: string): HierarchicalScope {
	return parent.createChild("thread", `scope_thread_${threadId}`);
}

export function createTurnScope(parent: HierarchicalScope, turnId: string): HierarchicalScope {
	return parent.createChild("turn", `scope_turn_${turnId}`);
}

export function createTaskScope(parent: HierarchicalScope, taskId: string): HierarchicalScope {
	return parent.createChild("task", `scope_task_${taskId}`);
}
