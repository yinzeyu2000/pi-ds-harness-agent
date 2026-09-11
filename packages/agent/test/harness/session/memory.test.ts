import { describe, expect, it, vi } from "vitest";
import { InMemorySessionRepo, InMemorySessionStorage, Session } from "../../../src/harness/session/index.ts";
import {
	createSessionBackendConformance,
	type SessionBackendFixture,
} from "../../../src/harness/session/testing/index.ts";

const conformance = createSessionBackendConformance(() =>
	Promise.resolve<SessionBackendFixture>({
		repository: new InMemorySessionRepo(),
		[Symbol.asyncDispose]: () => Promise.resolve(),
	}),
);

describe("InMemorySessionRepo conformance", () => {
	for (const group of new Set(conformance.map((testCase) => testCase.group))) {
		describe(group, () => {
			for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
				it(testCase.name, () => testCase.run());
			}
		});
	}
});

describe("Session with in-memory storage", () => {
	it("exposes the storage flush barrier through every lane view", async () => {
		const storage = new InMemorySessionStorage({ id: "session", createdAt: 1 });
		const flush = vi.spyOn(storage, "flush");
		const session = new Session(storage);
		await session.createLane("thread", null);

		await session.flush();
		await session.view("thread").flush();

		expect(flush).toHaveBeenCalledTimes(2);
	});

	it("uses one injectable id generator across lane views", async () => {
		let nextId = 0;
		const session = new Session(new InMemorySessionStorage({ id: "session", createdAt: 1 }), {
			idGenerator: { next: () => `generated-${++nextId}` },
		});
		const mainId = await session.appendCustomEntry("note");
		await session.createLane("thread", mainId);
		const threadId = await session.view("thread").appendCustomEntry("note");

		expect(mainId).toBe("generated-1");
		expect(threadId).toBe("generated-2");
	});
});
