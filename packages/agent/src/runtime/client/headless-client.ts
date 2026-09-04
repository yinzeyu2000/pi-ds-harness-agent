import {
	asClientRequestId,
	asControllerEpoch,
	type ClientRequestId,
	type ControllerEpoch,
	type ControllerLease,
	type ThreadId,
	type WireEventEnvelope,
} from "@earendil-works/pi-protocol";
import { MemoryExecutionBroker } from "../adapters/memory-execution-broker.ts";
import { PiAgentDriver } from "../driver/pi-agent-driver.ts";
import { MemoryJournalStore } from "../journal/memory-journal.ts";
import { HostLifecycleCoordinatorImpl } from "../runtime-host/lifecycle-coordinator-impl.ts";
import { RuntimeHostImpl } from "../runtime-host/runtime-host-impl.ts";
import { ThreadRuntimeImpl } from "../thread/thread-runtime-impl.ts";
import type { ExecutionBroker } from "../types/execution-broker.ts";
import type { ModelGateway } from "../types/model-gateway.ts";
import type { AdmittedTurn, ThreadRuntime } from "../types/thread-runtime.ts";

export interface HeadlessRuntimeOptions {
	readonly modelGateway: ModelGateway;
	readonly broker?: ExecutionBroker;
	readonly tools?: readonly any[];
}

export class HeadlessClient {
	readonly host: RuntimeHostImpl;
	readonly journalStore: MemoryJournalStore;
	readonly broker: ExecutionBroker;
	private readonly modelGateway: ModelGateway;
	private readonly tools: readonly any[];

	constructor(options: HeadlessRuntimeOptions) {
		this.journalStore = new MemoryJournalStore();
		const coordinator = new HostLifecycleCoordinatorImpl();
		this.host = new RuntimeHostImpl("headless-host", coordinator);
		this.modelGateway = options.modelGateway;
		this.broker = options.broker ?? new MemoryExecutionBroker();
		this.tools = options.tools ?? [];
	}

	async openThread(threadId: ThreadId): Promise<ThreadRuntime> {
		const existing = this.host.getRuntime(threadId);
		if (existing) return existing;

		const residency = await this.host.lifecycleCoordinator.startThread(threadId);
		const writer = await this.journalStore.open(threadId);

		const driver = new PiAgentDriver({
			modelGateway: this.modelGateway,
			executionBroker: this.broker,
			journalWriter: writer,
			tools: this.tools as any,
		});

		const runtime = new ThreadRuntimeImpl(threadId, residency.generation, writer, driver);
		this.host.registerRuntime(runtime);
		return runtime;
	}

	async startTurn(
		threadId: ThreadId,
		input: unknown,
		controllerEpoch: ControllerEpoch = asControllerEpoch(1),
		clientRequestId: ClientRequestId = asClientRequestId(`req_${Date.now()}`),
	): Promise<AdmittedTurn> {
		const runtime = await this.openThread(threadId);
		return runtime.startTurn(input, clientRequestId, controllerEpoch, "headless-user");
	}

	async acquireController(threadId: ThreadId, controllerId = "headless-controller"): Promise<ControllerLease> {
		const runtime = await this.openThread(threadId);
		return runtime.acquireController(controllerId);
	}

	async watchThread(
		threadId: ThreadId,
		listener: (event: WireEventEnvelope) => void,
	): Promise<{ dispose: () => void }> {
		const runtime = await this.openThread(threadId);
		return (runtime as ThreadRuntimeImpl).subscribe(listener);
	}
}
