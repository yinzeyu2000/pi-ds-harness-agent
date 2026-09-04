import { rm } from "node:fs/promises";
import { join } from "node:path";
import { asThreadId, asTurnId } from "@earendil-works/pi-protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type JournalDraft, MemoryJournalStore, type ToolAttemptFact } from "../../src/runtime/index.ts";
import { FileBlobStore } from "../../src/runtime/node.ts";

describe("Content-Addressed BlobStore and Write-Before-Publish", () => {
	const testDir = join(process.cwd(), "temp_test_blob_store");

	beforeEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	test("stores content-addressed blob with SHA-256 hash and retrieves buffer", async () => {
		const blobStore = new FileBlobStore(testDir);
		const payload = "Large tool output or file content to be stored outside of journal JSONL";

		const blobRef = await blobStore.put(payload, "text/plain");

		expect(blobRef.hash.length).toBe(64); // SHA-256 hex length
		expect(blobRef.sizeBytes).toBe(Buffer.byteLength(payload, "utf8"));
		expect(blobRef.uri).toBe(`blob://${blobRef.hash}`);

		const exists = await blobStore.has(blobRef.hash);
		expect(exists).toBe(true);

		const retrievedBuffer = await blobStore.get(blobRef);
		expect(retrievedBuffer).toBeDefined();
		expect(retrievedBuffer?.toString("utf8")).toBe(payload);
	});

	test("write-before-publish: blob persisted before referencing in Journal fact", async () => {
		const blobStore = new FileBlobStore(testDir);
		const journalStore = new MemoryJournalStore();
		const threadId = asThreadId("th_blob_order");
		const turnId = asTurnId("turn_b1");

		const writer = await journalStore.open(threadId);

		// Step 1: Write blob first (write-before-publish)
		const artifactData = JSON.stringify({ largeResult: [1, 2, 3, 4, 5], status: "ok" });
		const blobRef = await blobStore.put(artifactData, "application/json");

		// Step 2: Ensure blob is on disk before appending to journal
		expect(await blobStore.has(blobRef.hash)).toBe(true);

		// Step 3: Append journal fact referencing blob uri
		const toolFact: ToolAttemptFact = {
			factType: "tool_attempt",
			toolAttemptId: "tool_att_blob_1" as any,
			toolCallId: "call_blob_1" as any,
			turnId,
			toolName: "large_output_tool",
			status: "result",
			blobUri: blobRef.uri,
			outputHash: blobRef.hash,
		};

		const draft: JournalDraft = {
			schemaVersion: 1,
			threadId,
			turnId,
			record: { recordType: "runtime_fact", fact: toolFact },
		};

		await writer.append([draft]);
		await writer.flush();

		// Step 4: Verify that reader can resolve the blob from the journal record
		const envelopes: any[] = [];
		for await (const env of journalStore.load(threadId)) {
			envelopes.push(env);
		}

		expect(envelopes.length).toBe(1);
		const recordedFact = envelopes[0].record.fact as ToolAttemptFact;
		const refUri = recordedFact.blobUri!;
		expect(refUri).toBe(blobRef.uri);

		const retrieved = await blobStore.get(refUri);
		expect(retrieved?.toString("utf8")).toBe(artifactData);

		await writer.shutdown();
	});
});
