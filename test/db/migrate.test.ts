import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/db/store";

test("an older database gains the mood columns and keeps its rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "replyfold-migrate-"));
  try {
    const path = join(dir, "old.sqlite");
    const old = new Database(path, { create: true });
    old.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL, thread_hint TEXT, subject TEXT NOT NULL, customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', assignee_id TEXT, category TEXT NOT NULL DEFAULT 'other', last_message_at TEXT NOT NULL,
      last_inbound_at TEXT, snippet TEXT NOT NULL DEFAULT '', unread INTEGER NOT NULL DEFAULT 1);
      INSERT INTO conversations (id, mailbox_id, subject, customer_name, customer_email, last_message_at) VALUES ('c1', 'm1', 'Old', 'A', 'a@example.com', '2026-01-01T00:00:00Z');`);
    old.close();
    const store = new Store(path);
    expect(store.conversation("c1")).toMatchObject({ subject: "Old", mood: null });
    store.updateConversation("c1", { mood: "calm" });
    expect(store.listConversations({ view: "all", mood: "calm" }).map((row) => row.id)).toEqual(["c1"]);
    store.close();
    new Store(path).close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
