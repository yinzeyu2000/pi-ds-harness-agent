import type { AgentMessage } from "../../types.ts";
import {
	type EffectiveLaneConfiguration,
	type LaneReductionResult,
	type LaneState,
	reduceLaneState,
	type TerminalFailureState,
	type ToolBatchState,
} from "../reducer.ts";
import { buildSessionContext } from "./context.ts";
import type { Session } from "./session.ts";
import type { Entry, OperationStartedRecord } from "./types.ts";

export const SESSION_PROJECTION_IDS = {
	messages: "messages",
	turnState: "turn-state",
	toolState: "tool-state",
} as const;

export interface SessionProjectionSnapshot {
	lane: string;
	watermark: number;
	messages: AgentMessage[];
	turnState: LaneState;
	toolState: ToolBatchState | null;
	effectiveConfiguration: EffectiveLaneConfiguration;
	terminalFailure: TerminalFailureState | null;
}

export interface ProjectSessionOptions {
	lane?: string;
	defaults?: EffectiveLaneConfiguration;
}

const DEFAULT_CONFIGURATION: EffectiveLaneConfiguration = {
	model: { provider: "unknown", modelId: "unknown" },
	thinkingLevel: "off",
	activeToolNames: [],
};

/**
 * Builds the three canonical read models from one flushed Session snapshot.
 * Callers must serialize this read with external writers that do not use this Session instance.
 */
export async function projectSession(
	session: Session,
	options: ProjectSessionOptions = {},
): Promise<SessionProjectionSnapshot> {
	const lane = options.lane ?? "main";
	await session.flush();
	const [lanes, allEntries, records, openOperations, log] = await Promise.all([
		session.getLanes(),
		session.findEntries({ order: "oldestFirst" }),
		session.findRecords({ lane, order: "oldestFirst" }),
		session.findOpenOperations(lane, { limit: 2 }),
		session.getLog(),
	]);
	const leafId = lanes.find((pointer) => pointer.lane === lane)?.leafId;
	if (leafId === undefined) throw new Error(`Session lane does not exist: ${lane}`);
	const branchEntries = leafId ? await session.findEntriesOnBranch({ start: leafId, order: "oldestFirst" }) : [];
	const started = openOperations[0];
	const configurationEntries = await configurationEntriesAtAnchor(session, started, branchEntries);
	const reduction = reduceLaneState({
		lane,
		leafId,
		openOperations,
		records,
		entries: allEntries,
		ownEntries: started ? branchEntries.filter((entry) => entry.seq > started.seq) : [],
		configurationEntries,
		defaults: structuredClone(options.defaults ?? DEFAULT_CONFIGURATION),
	});
	return snapshotFromReduction(lane, log.at(-1)?.seq ?? 0, branchEntries, reduction);
}

function projectMessages(branchEntries: readonly Entry[]): AgentMessage[] {
	return structuredClone(buildSessionContext(branchEntries).messages);
}

function projectTurnState(reduction: LaneReductionResult): LaneState {
	return structuredClone(reduction.laneState);
}

function projectToolState(turnState: LaneState): ToolBatchState | null {
	return structuredClone(turnState.operation?.toolBatch ?? null);
}

function snapshotFromReduction(
	lane: string,
	watermark: number,
	branchEntries: readonly Entry[],
	reduction: LaneReductionResult,
): SessionProjectionSnapshot {
	const turnState = projectTurnState(reduction);
	return {
		lane,
		watermark,
		messages: projectMessages(branchEntries),
		turnState,
		toolState: projectToolState(turnState),
		effectiveConfiguration: structuredClone(reduction.effectiveConfiguration),
		terminalFailure: structuredClone(reduction.terminalFailure),
	};
}

async function configurationEntriesAtAnchor(
	session: Session,
	started: OperationStartedRecord | undefined,
	branchEntries: readonly Entry[],
): Promise<Entry[]> {
	if (!started) return [...branchEntries];
	if (started.sourceLeafId === null) return [];
	return session.findEntriesOnBranch({ start: started.sourceLeafId, order: "oldestFirst" });
}
