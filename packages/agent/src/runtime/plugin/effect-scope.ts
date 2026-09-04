import type { Effect } from "./context.ts";

export class EffectScope implements Effect {
	private readonly abortController = new AbortController();
	private readonly disposers: Array<() => void | Promise<void>> = [];
	private disposed = false;

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	add(disposer: () => void | Promise<void>): Effect {
		if (this.disposed) {
			throw new Error("Cannot add effect: scope is already disposed");
		}
		let active = true;
		const registration = async () => {
			if (!active) return;
			active = false;
			await disposer();
		};
		this.disposers.push(registration);
		return {
			dispose: registration,
		};
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.abortController.abort();

		const errors: unknown[] = [];
		for (let i = this.disposers.length - 1; i >= 0; i--) {
			try {
				await this.disposers[i]!();
			} catch (err) {
				errors.push(err);
			}
		}
		this.disposers.length = 0;

		if (errors.length > 0) {
			throw new AggregateError(errors, "One or more effects failed to dispose");
		}
	}
}
