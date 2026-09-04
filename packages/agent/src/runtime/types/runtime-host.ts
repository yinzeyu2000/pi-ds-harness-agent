import type { RuntimeGeneration, ThreadId } from "@earendil-works/pi-protocol";
import type { ThreadDurableState, ThreadResidencyState } from "./state-machines.ts";

export interface ThreadResidencyPin {
	readonly pinId: string;
	readonly reason: string;
	readonly acquiredAt: number;
}

export interface ThreadResidencyRecord {
	readonly threadId: ThreadId;
	readonly generation: RuntimeGeneration;
	readonly residencyState: ThreadResidencyState;
	readonly durableState: ThreadDurableState;
	readonly loadedAt: number;
	readonly activePins: readonly ThreadResidencyPin[];
}

export interface LifecycleShutdownSummary {
	readonly completed: readonly ThreadId[];
	readonly submitFailed: readonly ThreadId[];
	readonly timedOut: readonly ThreadId[];
}

export interface HostLifecycleCoordinator {
	startThread(threadId: ThreadId): Promise<ThreadResidencyRecord>;
	resumeThread(threadId: ThreadId): Promise<ThreadResidencyRecord>;
	unloadThread(threadId: ThreadId, expectedGeneration: RuntimeGeneration, force?: boolean): Promise<boolean>;
	archiveThread(threadId: ThreadId): Promise<void>;
	deleteThread(threadId: ThreadId): Promise<void>;
	pinThread(threadId: ThreadId, pinId: string, reason: string): Promise<void>;
	unpinThread(threadId: ThreadId, pinId: string): Promise<void>;
	shutdownAll(timeoutMs?: number): Promise<LifecycleShutdownSummary>;
	getResidency(threadId: ThreadId): ThreadResidencyRecord | undefined;
}

export interface RuntimeHost {
	readonly hostId: string;
	readonly lifecycleCoordinator: HostLifecycleCoordinator;
	isLoaded(threadId: ThreadId): boolean;
	listLoadedThreads(): readonly ThreadId[];
}
