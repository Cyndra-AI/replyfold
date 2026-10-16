import { describe, expect, test } from "bun:test";
import { Store } from "../../src/db/store";
import type { MailProvider, PulledMessage, PullResult } from "../../src/mail/provider";
import { syncMailbox } from "../../src/mail/sync";

const SUPPORT = "help@shop.test";

function message(overrides: Partial<PulledMessage> & { externalId: string }): PulledMessage {
  return {
    threadHint: null,
    messageIdHeader: `<${overrides.externalId}@mail.test>`,
    inReplyTo: "",
    references: [],
    from: { name: "Dana Lee", email: "dana@example.com" },
    to: [{ name: "", email: SUPPORT }],
    cc: [],
    subject: "Where is my order?",
    text: "Hi, my order has not arrived.",
    sentAt: "2026-03-01T10:00:00.000Z",
    attachments: [],
    ...overrides,
  };
}

class ScriptedProvider implements MailProvider {
  readonly kind = "demo" as const;
  readonly address = SUPPORT;
  cursors: Array<string | null> = [];
  constructor(private pages: Array<PullResult | Error>) {}
  async pull(cursor: string | null) {
    this.cursors.push(cursor);
    const page = this.pages.shift() ?? { messages: [], cursor: cursor ?? "" };
    if (page instanceof Error) throw page;
    return page;
  }
  async send(): Promise<never> {
    throw new Error("not used");
  }
}

function setup(pages: Array<PullResult | Error>) {
  const store = new Store();
  const mailbox = store.createMailbox({ provider: "demo", address: SUPPORT, displayName: "Support", credentials: "{}" });
  return { store, mailbox, provider: new ScriptedProvider(pages) };
}

describe("syncMailbox", () => {
  test("stores new customer mail as an open conversation and queues one draft", async () => {
    const { store, mailbox, provider } = setup([{ messages: [message({ externalId: "m1" })], cursor: "c1" }]);
    const result = await syncMailbox({ store, mailbox, provider });
    expect(result).toEqual({ ok: true, added: 1, draftsQueued: 1 });
    const [conversation] = store.listConversations({ view: "all" });
    expect(conversation?.customer).toEqual({ name: "Dana Lee", email: "dana@example.com" });
    expect(conversation?.status).toBe("open");
    expect(store.currentDraft(conversation!.id)?.state).toBe("queued");
    expect(store.mailboxSecrets(mailbox.id)?.cursor).toBe("c1");
  });

  test("passes the stored cursor and skips messages it already has", async () => {
    const { store, mailbox, provider } = setup([
      { messages: [message({ externalId: "m1" })], cursor: "c1" },
      { messages: [message({ externalId: "m1" })], cursor: "c2" },
    ]);
    await syncMailbox({ store, mailbox, provider });
    const second = await syncMailbox({ store, mailbox, provider });
    expect(provider.cursors).toEqual([null, "c1"]);
    expect(second).toEqual({ ok: true, added: 0, draftsQueued: 0 });
    expect(store.listConversations({ view: "all" })).toHaveLength(1);
  });

  test("skips a copy of a stored message that arrives under another provider id", async () => {
    const { store, mailbox, provider } = setup([
      { messages: [message({ externalId: "m1", messageIdHeader: "<same@mail.test>" })], cursor: "c1" },
      { messages: [message({ externalId: "copy-in-sent", messageIdHeader: "<same@mail.test>" })], cursor: "c2" },
    ]);
    await syncMailbox({ store, mailbox, provider });
    expect(await syncMailbox({ store, mailbox, provider })).toEqual({ ok: true, added: 0, draftsQueued: 0 });
  });

  test("threads a reply by References when the provider gives no thread id", async () => {
    const { store, mailbox, provider } = setup([
      {
        messages: [
          message({ externalId: "m1" }),
          message({
            externalId: "m2",
            subject: "Re: Where is my order?",
            references: ["<m1@mail.test>"],
            inReplyTo: "<m1@mail.test>",
            sentAt: "2026-03-01T11:00:00.000Z",
          }),
        ],
        cursor: "c1",
      },
    ]);
    await syncMailbox({ store, mailbox, provider });
    const conversations = store.listConversations({ view: "all" });
    expect(conversations).toHaveLength(1);
    expect(store.messages(conversations[0]!.id)).toHaveLength(2);
  });

  test("marks mail from the mailbox address as outbound and queues no draft for it", async () => {
    const { store, mailbox, provider } = setup([
      {
        messages: [
          message({ externalId: "m1", threadHint: "t1" }),
          message({
            externalId: "m2",
            threadHint: "t1",
            from: { name: "Support", email: SUPPORT },
            to: [{ name: "Dana Lee", email: "dana@example.com" }],
            sentAt: "2026-03-01T12:00:00.000Z",
          }),
        ],
        cursor: "c1",
      },
    ]);
    const result = await syncMailbox({ store, mailbox, provider });
    expect(result).toEqual({ ok: true, added: 2, draftsQueued: 0 });
    const [conversation] = store.listConversations({ view: "all" });
    expect(store.messages(conversation!.id).map((item) => item.direction)).toEqual(["inbound", "outbound"]);
    expect(conversation?.customer.email).toBe("dana@example.com");
  });

  test("a newer customer message replaces the draft for the older one", async () => {
    const { store, mailbox, provider } = setup([
      { messages: [message({ externalId: "m1", threadHint: "t1" })], cursor: "c1" },
      { messages: [message({ externalId: "m2", threadHint: "t1", sentAt: "2026-03-02T09:00:00.000Z" })], cursor: "c2" },
    ]);
    await syncMailbox({ store, mailbox, provider });
    const [conversation] = store.listConversations({ view: "all" });
    const first = store.currentDraft(conversation!.id)!;
    await syncMailbox({ store, mailbox, provider });
    expect(store.draft(first.id)?.state).toBe("discarded");
    expect(store.draft(first.id)?.discardReason).toBe("superseded");
    expect(store.currentDraft(conversation!.id)?.id).not.toBe(first.id);
  });

  test("reopens a closed conversation when the customer writes again", async () => {
    const { store, mailbox, provider } = setup([
      { messages: [message({ externalId: "m1", threadHint: "t1" })], cursor: "c1" },
      { messages: [message({ externalId: "m2", threadHint: "t1", sentAt: "2026-03-03T09:00:00.000Z" })], cursor: "c2" },
    ]);
    await syncMailbox({ store, mailbox, provider });
    const [conversation] = store.listConversations({ view: "all" });
    store.updateConversation(conversation!.id, { status: "closed" });
    await syncMailbox({ store, mailbox, provider });
    expect(store.conversation(conversation!.id)?.status).toBe("open");
  });

  test("records a provider failure on the mailbox and keeps the old cursor", async () => {
    const { store, mailbox, provider } = setup([
      { messages: [message({ externalId: "m1" })], cursor: "c1" },
      new Error("IMAP login failed"),
    ]);
    await syncMailbox({ store, mailbox, provider });
    const result = await syncMailbox({ store, mailbox, provider });
    expect(result).toEqual({ ok: false, error: "IMAP login failed" });
    expect(store.mailbox(mailbox.id)?.status).toBe("error");
    expect(store.mailbox(mailbox.id)?.lastError).toBe("IMAP login failed");
    expect(store.mailboxSecrets(mailbox.id)?.cursor).toBe("c1");
  });
});
