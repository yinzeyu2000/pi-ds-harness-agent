import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { ThreadId } from "@earendil-works/pi-protocol";
import type { JournalEnvelope, ThreadJournalStore } from "../types/journal.ts";
import { projectThreadSnapshot } from "./projection.ts";

export interface ThreadIndexEntry {
	readonly threadId: ThreadId;
	readonly title?: string;
	readonly durableStatus: "active" | "archived" | "deleted";
	readonly itemsCount: number;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly durableWatermarkSeq: number;
}

export interface ListThreadsOptions {
	readonly status?: "active" | "archived" | "deleted";
	readonly limit?: number;
	readonly offset?: number;
}

export class RebuildableThreadIndex {
	private readonly entries = new Map<string, ThreadIndexEntry>();
	readonly indexPath?: string;

	constructor(indexPath?: string) {
		this.indexPath = indexPath;
	}

	async initialize(): Promise<void> {
		if (this.indexPath && existsSync(this.indexPath)) {
			const data = await readFile(this.indexPath, "utf8");
			if (data.trim().length > 0) {
				const parsed = JSON.parse(data) as ThreadIndexEntry[];
				for (const item of parsed) {
					this.entries.set(item.threadId, item);
				}
			}
		}
	}

	async upsert(entry: ThreadIndexEntry): Promise<void> {
		this.entries.set(entry.threadId, entry);
		await this.persist();
	}

	async get(threadId: ThreadId): Promise<ThreadIndexEntry | undefined> {
		return this.entries.get(threadId);
	}

	async list(options?: ListThreadsOptions): Promise<ThreadIndexEntry[]> {
		let result = Array.from(this.entries.values());

		if (options?.status) {
			result = result.filter((e) => e.durableStatus === options.status);
		}

		// Sort by updatedAt descending
		result.sort((a, b) => b.updatedAt - a.updatedAt);

		const offset = options?.offset ?? 0;
		const limit = options?.limit ?? result.length;

		return result.slice(offset, offset + limit);
	}

	async delete(threadId: ThreadId): Promise<void> {
		this.entries.delete(threadId);
		await this.persist();
	}

	async clear(): Promise<void> {
		this.entries.clear();
		await this.persist();
	}

	async rebuildFromStore(
		store: ThreadJournalStore,
		threadIds: readonly ThreadId[],
	): Promise<{ rebuiltCount: number }> {
		this.entries.clear();
		let count = 0;

		for (const threadId of threadIds) {
			const envelopes: JournalEnvelope[] = [];
			for await (const env of store.load(threadId)) {
				envelopes.push(env);
			}

			if (envelopes.length === 0) continue;

			const snapshot = projectThreadSnapshot(threadId, envelopes);
			let itemsCount = 0;
			let title: string | undefined;

			for (const env of envelopes) {
				if (env.record.recordType === "entry" && (env.record as any).entry?.type === "message") {
					itemsCount++;
					if (!title) {
						const msg = (env.record as any).entry?.message;
						if (msg && typeof msg.content === "string") {
							title = msg.content.slice(0, 50);
						} else if (msg && Array.isArray(msg.content) && msg.content[0]?.text) {
							title = msg.content[0].text.slice(0, 50);
						}
					}
				}
			}

			const entry: ThreadIndexEntry = {
				threadId,
				title,
				durableStatus: snapshot.durableStatus,
				itemsCount,
				createdAt: snapshot.createdAt,
				updatedAt: snapshot.updatedAt,
				durableWatermarkSeq: snapshot.durableWatermarkSeq,
			};

			this.entries.set(threadId, entry);
			count++;
		}

		await this.persist();
		return { rebuiltCount: count };
	}

	private async persist(): Promise<void> {
		if (!this.indexPath) return;
		const data = JSON.stringify(Array.from(this.entries.values()), null, 2);
		await writeFile(this.indexPath, data, "utf8");
	}
}
