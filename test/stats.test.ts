import { describe, expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { sendReply } from "../src/drafts/send";
import type { MailProvider } from "../src/mail/provider";
import { computeStats } from "../src/stats";

const provider: MailProvider = {
  kind: "demo",
  address: "help@shop.test",
  async pull() {
    return { messages: [], cursor: "" };
  },
  async send(mail) {
    return { externalId: crypto.randomUUID(), messageIdHeader: mail.messageIdHeader, threadHint: null };
  },
};

describe("computeStats", () => {
  test("counts mail per day, edit quality per person and first response time", async () => {
    const store = new Store();
    const user = store.createUser({ email: "kim@shop.test", name: "Kim", role: "agent", passwordHash: "x" });
    const mailbox = store.createMailbox({ provider: "demo", address: "help@shop.test", displayName: "Support", credentials: "{}" });
    const inboundAt = new Date(Date.now() - 90 * 60_000).toISOString();
    for (const [index, body] of ["Thanks, it shipped today.", "Totally different text written by hand."].entries()) {
      const conversation = store.createConversation({
        mailboxId: mailbox.id,
        threadHint: `t${index}`,
        subject: "Order",
        customer: { name: "C", email: `c${index}@example.com` },
        at: inboundAt,
      });
      const message = store.insertMessage({
        conversationId: conversation.id,
        mailboxId: mailbox.id,
        externalId: `in${index}`,
        direction: "inbound",
        from: { name: "C", email: `c${index}@example.com` },
        to: [],
        cc: [],
        subject: "Order",
        text: "Where is it?",
        sentAt: inboundAt,
        messageIdHeader: `<in${index}@x>`,
        references: [],
      })!;
      store.updateConversation(conversation.id, { category: "shipping" });
      const draft = store.createDraft({ conversationId: conversation.id, forMessageId: message.id });
      store.updateDraft(draft.id, { state: "ready", body: "Thanks, it shipped today." });
      await sendReply({ store, providerFor: () => provider, user: store.user(user.id)!, conversationId: conversation.id, draftId: draft.id, body, key: `k${index}` });
    }
    const from = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const stats = computeStats(store, { from, to: new Date().toISOString() });
    expect(stats.received).toBe(2);
    expect(stats.sent).toBe(2);
    expect(stats.edits).toEqual({ unchanged: 1, light: 0, heavy: 1, manual: 0 });
    expect(stats.people).toEqual([{ userId: user.id, name: "Kim", sent: 2, unchanged: 1, light: 0, heavy: 1 }]);
    expect(stats.categories).toEqual([{ category: "shipping", count: 2 }]);
    expect(stats.medianFirstResponseMinutes).toBeGreaterThan(89);
    expect(stats.medianFirstResponseMinutes).toBeLessThan(91);
    expect(stats.daily.length).toBeGreaterThanOrEqual(3);
  });
});
