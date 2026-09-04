import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface BlobRef {
	readonly hash: string;
	readonly sizeBytes: number;
	readonly mimeType?: string;
	readonly uri: string;
}

export interface BlobStore {
	put(data: Buffer | string, mimeType?: string): Promise<BlobRef>;
	get(refOrHash: BlobRef | string): Promise<Buffer | undefined>;
	has(hash: string): Promise<boolean>;
}

export class FileBlobStore implements BlobStore {
	readonly storageDir: string;
	readonly blobsDir: string;

	constructor(storageDir: string) {
		this.storageDir = storageDir;
		this.blobsDir = join(storageDir, "blobs");
	}

	private getBlobPath(hash: string): string {
		const prefix = hash.slice(0, 2);
		return join(this.blobsDir, prefix, hash);
	}

	async put(data: Buffer | string, mimeType?: string): Promise<BlobRef> {
		const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
		const hash = createHash("sha256").update(buffer).digest("hex");
		const blobPath = this.getBlobPath(hash);

		if (!existsSync(blobPath)) {
			await mkdir(dirname(blobPath), { recursive: true });
			// Write and fsync to guarantee write-before-publish durability
			const handle = await open(blobPath, "w");
			try {
				await handle.write(buffer);
				await handle.sync();
			} finally {
				await handle.close();
			}
		}

		return {
			hash,
			sizeBytes: buffer.byteLength,
			mimeType,
			uri: `blob://${hash}`,
		};
	}

	async get(refOrHash: BlobRef | string): Promise<Buffer | undefined> {
		const hash = typeof refOrHash === "string" ? refOrHash.replace(/^blob:\/\//, "") : refOrHash.hash;
		const blobPath = this.getBlobPath(hash);

		if (!existsSync(blobPath)) {
			return undefined;
		}

		return readFile(blobPath);
	}

	async has(hash: string): Promise<boolean> {
		const blobPath = this.getBlobPath(hash.replace(/^blob:\/\//, ""));
		return existsSync(blobPath);
	}

	async getSizeBytes(hash: string): Promise<number | undefined> {
		const blobPath = this.getBlobPath(hash.replace(/^blob:\/\//, ""));
		if (!existsSync(blobPath)) return undefined;
		const s = await stat(blobPath);
		return s.size;
	}
}
