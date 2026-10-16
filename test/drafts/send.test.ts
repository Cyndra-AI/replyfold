import { describe, expect, test } from "bun:test";
import { Store } from "../../src/db/store";
import { composeNew, sendReply } from "../../src/drafts/send";
import { SendRejectedError, type MailProvider, type OutgoingMail } from "../../src/mail/provider";

class RecordingProvider implements MailProvider {
  readonly kind = "demo" as const;
  readonly address = "help@shop.test";
  sent: OutgoingMail[] = [];
  constructor(private outcome: "ok" | "reject" | "timeout" = "ok") {}
  async pull() {
    return { messages: [], cursor: "" };
  }
  async send(mail: OutgoingMail) {
    if (this.outcome === "reject") throw new SendRejectedError("550 no such user");
    if (this.outcome === "timeout") throw new Error("socket hang up");
    this.sent.push(mail);
    return { externalId: `sent-${this.sent.length}`, messageIdHeader: mail.messageIdHeader, threadHint: "t1" };
  }
}

function seed() {
  const store = new Store();
  const user = store.createUser({ email: "kim@shop.test", name: "Kim Park", role: "agent", passwordHash: "x" });
  store.updateUser(user.id, { signature: "Kim\nShop support" });
  const mailbox = store.createMailbox({ provider: "demo", address: "help@shop.test", displayName: "Shop Support", credentials: "{}" });
  const conversation = store.createConversation({
    mailboxId: mailbox.id,
    threadHint: "t1",
    subject: "Order 1042",
    customer: { name: "Dana Lee", email: "dana@example.com" },
    at: "2026-03-01T10:00:00Z",
  });
  const inbound = store.insertMessage({
    conversationId: conversation.id,
    mailboxId: mailbox.id,
    externalId: "e1",
    direction: "inbound",
    from: { name: "Dana Lee", email: "dana@example.com" },
    to: [{ name: "", email: "help@shop.test" }],
    cc: [{ name: "Alex", email: "alex@example.com" }],
    subject: "Order 1042",
    text: "Where is it?",
    sentAt: "2026-03-01T10:00:00Z",
    messageIdHeader: "<e1@example.com>",
    references: ["<e0@example.com>"],
  })!;
  const draft = store.createDraft({ conversationId: conversation.id, forMessageId: inbound.id });
  store.updateDraft(draft.id, { state: "ready", body: "Hello Dana,\n\nIt shipped on Monday and arrives Friday." });
  return { store, user: store.user(user.id)!, conversation, draft };
}

describe("sendReply", () => {
  test("sends a threaded reply with the signature and files it", async () => {
    const { store, user, conversation, draft } = seed();
    const provider = new RecordingProvider();
    const result = await sendReply({
      store,
      providerFor: () => provider,
      user,
      conversationId: conversation.id,
      draftId: draft.id,
      body: "Hello Dana,\n\nIt shipped on Monday and arrives Thursday.",
      key: "k1",
    });
    expect(result.state).toBe("sent");
    const mail = provider.sent[0]!;
    expect(mail.to).toEqual([{ name: "Dana Lee", email: "dana@example.com" }]);
    expect(mail.cc).toEqual([{ name: "Alex", email: "alex@example.com" }]);
    expect(mail.subject).toBe("Re: Order 1042");
    expect(mail.inReplyTo).toBe("<e1@example.com>");
    expect(mail.references).toEqual(["<e0@example.com>", "<e1@example.com>"]);
    expect(mail.replyToExternalId).toBe("e1");
    expect(mail.text).toEndWith("Kim\nShop support");
    expect(mail.from).toEqual({ name: "Shop Support", email: "help@shop.test" });

    const messages = store.messages(conversation.id);
    expect(messages.at(-1)).toMatchObject({ direction: "outbound", sentByUserId: user.id });
    expect(store.draft(draft.id)).toMatchObject({ state: "sent", editClass: "light" });
    expect(store.conversation(conversation.id)?.status).toBe("waiting");
  });

  test("the same idempotency key never sends twice", async () => {
    const { store, user, conversation, draft } = seed();
    const provider = new RecordingProvider();
    const send = () =>
      sendReply({ store, providerFor: () => provider, user, conversationId: conversation.id, draftId: draft.id, body: "Hi", key: "same" });
    await send();
    const again = await send();
    expect(provider.sent).toHaveLength(1);
    expect(again.state).toBe("sent");
  });

  test("a refusal is a failed send that can be retried", async () => {
    const { store, user, conversation, draft } = seed();
    const result = await sendReply({
      store,
      providerFor: () => new RecordingProvider("reject"),
      user,
      conversationId: conversation.id,
      draftId: draft.id,
      body: "Hi",
      key: "k2",
    });
    expect(result).toMatchObject({ state: "failed", error: "550 no such user" });
    expect(store.draft(draft.id)?.state).toBe("ready");
  });

  test("a network failure after the request left is uncertain and notifies the sender", async () => {
    const { store, user, conversation, draft } = seed();
    const result = await sendReply({
      store,
      providerFor: () => new RecordingProvider("timeout"),
      user,
      conversationId: conversation.id,
      draftId: draft.id,
      body: "Hi",
      key: "k3",
    });
    expect(result.state).toBe("uncertain");
    expect(store.notifications(user.id)[0]?.kind).toBe("send_uncertain");
    expect(store.messages(conversation.id)).toHaveLength(1);
  });
});

describe("composeNew", () => {
  test("starts a conversation with an outbound message", async () => {
    const { store, user } = seed();
    const provider = new RecordingProvider();
    const mailbox = store.listMailboxes()[0]!;
    const result = await composeNew({
      store,
      providerFor: () => provider,
      user,
      mailboxId: mailbox.id,
      to: [{ name: "", email: "lee@example.com" }],
      cc: [],
      subject: "Your replacement",
      body: "Hello Lee, a replacement is on its way.",
      key: "new-1",
    });
    expect(result.state).toBe("sent");
    const conversation = store.conversation(result.conversationId)!;
    expect(conversation).toMatchObject({ subject: "Your replacement", status: "waiting", customer: { email: "lee@example.com" } });
    expect(provider.sent[0]?.inReplyTo).toBeUndefined();
  });
});
