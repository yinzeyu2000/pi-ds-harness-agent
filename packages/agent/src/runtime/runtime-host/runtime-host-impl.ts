import type { ThreadId } from "@earendil-works/pi-protocol";
import type { HostLifecycleCoordinator, RuntimeHost } from "../types/runtime-host.ts";
import type { ThreadRuntime } from "../types/thread-runtime.ts";
import { HostLifecycleCoordinatorImpl } from "./lifecycle-coordinator-impl.ts";

export class RuntimeHostImpl implements RuntimeHost {
	readonly hostId: string;
	readonly lifecycleCoordinator: HostLifecycleCoordinator;
	private readonly runtimes = new Map<string, ThreadRuntime>();

	constructor(hostId = "host-001", coordinator?: HostLifecycleCoordinator) {
		this.hostId = hostId;
		this.lifecycleCoordinator = coordinator ?? new HostLifecycleCoordinatorImpl();
	}

	registerRuntime(runtime: ThreadRuntime): void {
		this.runtimes.set(runtime.threadId, runtime);
	}

	unregisterRuntime(threadId: ThreadId): void {
		this.runtimes.delete(threadId);
	}

	getRuntime(threadId: ThreadId): ThreadRuntime | undefined {
		return this.runtimes.get(threadId);
	}

	isLoaded(threadId: ThreadId): boolean {
		return this.runtimes.has(threadId);
	}

	listLoadedThreads(): readonly ThreadId[] {
		return Array.from(this.runtimes.values()).map((r) => r.threadId);
	}
}
