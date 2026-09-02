export type EventListener<T> = (event: T) => void | Promise<void>;

export interface ObserverError {
	event: string;
	error: unknown;
}

export class LiveEventBus<TEvents extends object> {
	private readonly listeners = new Map<keyof TEvents, Set<EventListener<unknown>>>();
	private readonly onObserverError: (failure: ObserverError) => void;

	constructor(onObserverError: (failure: ObserverError) => void = () => {}) {
		this.onObserverError = onObserverError;
	}

	on<TKey extends keyof TEvents>(event: TKey, listener: EventListener<TEvents[TKey]>): () => void {
		const listeners = this.listeners.get(event) ?? new Set<EventListener<unknown>>();
		listeners.add(listener as EventListener<unknown>);
		this.listeners.set(event, listeners);
		return () => listeners.delete(listener as EventListener<unknown>);
	}

	async emit<TKey extends keyof TEvents>(event: TKey, payload: TEvents[TKey]): Promise<void> {
		for (const listener of [...(this.listeners.get(event) ?? [])]) {
			try {
				await listener(payload);
			} catch (error) {
				this.onObserverError({ event: String(event), error });
			}
		}
	}

	clear(): void {
		this.listeners.clear();
	}

	get listenerCount(): number {
		let count = 0;
		for (const listeners of this.listeners.values()) count += listeners.size;
		return count;
	}
}

export type WaterfallHandler<TContext, TValue> = (
	context: TContext,
	value: TValue,
	next: (nextValue: TValue) => Promise<TValue>,
) => Promise<TValue>;

export async function runWaterfall<TContext, TValue>(
	context: TContext,
	initialValue: TValue,
	handlers: readonly WaterfallHandler<TContext, TValue>[],
): Promise<TValue> {
	const dispatch = async (index: number, value: TValue): Promise<TValue> => {
		const handler = handlers[index];
		if (!handler) return value;
		let called = false;
		return handler(context, value, async (nextValue) => {
			if (called) throw new Error("Waterfall next() may only be called once");
			called = true;
			return dispatch(index + 1, nextValue);
		});
	};
	return dispatch(0, initialValue);
}

export async function runParallelBarrier<T>(handlers: ReadonlyArray<() => Promise<T> | T>): Promise<T[]> {
	return Promise.all(handlers.map((handler) => handler()));
}

export type GuardDecision = { decision: "allow" } | { decision: "deny"; reason: string };
export type Guard<TContext> = (context: TContext) => GuardDecision | Promise<GuardDecision>;

export async function runMonotonicGuards<TContext>(
	context: TContext,
	guards: readonly Guard<TContext>[],
): Promise<GuardDecision> {
	for (const guard of guards) {
		const result = await guard(context);
		if (result.decision === "deny") return result;
	}
	return { decision: "allow" };
}
