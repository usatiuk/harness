import { it, expect } from "vitest";
import { storeContract } from "@harness/testkit/contract";
import { counterIdGenerator, fixedClock } from "@harness/testkit";
import { InMemoryStore } from "./in-memory-store.ts";

storeContract("InMemoryStore", () => new InMemoryStore(counterIdGenerator(), fixedClock()));

it("paginates tied Unicode folder names with the same binary order as SQLite", async () => {
  const store = new InMemoryStore(undefined, { now: () => 1 });
  const names = ["/a", "/_a", "/A", "/\ue000", "/😀"];
  for (const workspaceRoot of names)
    await store.createConversation({ workspaceRoot, overrides: {} });
  const seen: string[] = [];
  let cursor: { workspaceRoot: string; lastUsedAt: number } | undefined;
  for (;;) {
    const page = await store.listConversationProjects(1, cursor);
    if (!page.length) break;
    seen.push(page[0]!.workspaceRoot);
    cursor = page[0];
  }
  expect(seen).toEqual(names.sort((a, b) => Buffer.compare(Buffer.from(b), Buffer.from(a))));
});
