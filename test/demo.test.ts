import { expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { seedDemo } from "../src/demo/seed";
import { computeStats } from "../src/stats";

test("demo seed builds an open inbox with drafts and two weeks of history", async () => {
  const store = new Store();
  const now = Date.now();
  await seedDemo(store, now);
  const open = store.listConversations({ view: "open" });
  expect(open).toHaveLength(10);
  const drafts = open.map((conversation) => store.currentDraft(conversation.id)?.state);
  expect(drafts.filter((state) => state === "ready")).toHaveLength(9);
  expect(drafts.filter((state) => state === "failed")).toHaveLength(1);
  expect(store.suggestions("pending")).toHaveLength(1);
  const stats = computeStats(store, { from: new Date(now - 14 * 86_400_000).toISOString(), to: new Date(now).toISOString() });
  expect(stats.sent).toBeGreaterThanOrEqual(30);
  expect(stats.edits.heavy).toBeGreaterThan(0);
  await seedDemo(store, now);
  expect(store.countUsers()).toBe(4);
});
