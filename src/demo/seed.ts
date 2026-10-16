import { ModelClassifier } from "../ai/classifier";
import type { Store } from "../db/store";
import { learnFromEdit } from "../drafts/learning";
import { sendReply } from "../drafts/send";
import { generateDraft } from "../drafts/workflow";
import { syncMailbox } from "../mail/sync";
import { DEMO_MAILBOX, DEMO_PASSWORD, DEMO_PLAYBOOK, DEMO_TEAM, demoHistory } from "./fixtures";
import { DemoModel } from "./model";
import { DemoProvider } from "./provider";

export async function seedDemo(store: Store, now = Date.now()) {
  if (store.countUsers() > 0) return;
  const passwordHash = await Bun.password.hash(DEMO_PASSWORD);
  const team = DEMO_TEAM.map((member) => {
    const user = store.createUser({ email: member.email, name: member.name, role: member.role, passwordHash });
    return store.updateUser(user.id, { signature: member.signature })!;
  });
  store.savePlaybook(DEMO_PLAYBOOK, "First version", team[0]!.id);
  const mailbox = store.createMailbox({ provider: "demo", address: DEMO_MAILBOX.address, displayName: DEMO_MAILBOX.displayName, credentials: "{}" });
  const provider = new DemoProvider(() => now);
  const model = new DemoModel();
  const iso = (time: number) => new Date(time).toISOString();

  for (const item of demoHistory()) {
    const askedAt = now - item.daysAgo * 86_400_000 - 3 * 3_600_000;
    const conversation = store.createConversation({
      mailboxId: mailbox.id,
      threadHint: item.hint,
      subject: item.subject,
      customer: item.customer,
      at: iso(askedAt),
    });
    const inbound = store.insertMessage({
      conversationId: conversation.id,
      mailboxId: mailbox.id,
      externalId: `${item.hint}-in`,
      direction: "inbound",
      from: item.customer,
      to: [{ name: DEMO_MAILBOX.displayName, email: DEMO_MAILBOX.address }],
      cc: [],
      subject: item.subject,
      text: item.ask,
      sentAt: iso(askedAt),
      messageIdHeader: `<${item.hint}-in@demo.fernhill.example>`,
      references: [],
    })!;
    const draft = store.createDraft({ conversationId: conversation.id, forMessageId: inbound.id });
    store.updateDraft(draft.id, {
      state: "ready",
      body: item.draft,
      model: model.name,
      analysis: {
        summary: item.ask,
        intent: item.subject,
        category: /chip/i.test(item.subject) ? "returns" : /code|cancel/i.test(item.subject) ? "billing" : /stock|wrap/i.test(item.subject) ? "product" : "shipping",
        disposition: "reply",
        needsHuman: false,
        missingInformation: [],
        facts: [],
        confidence: 0.7 + (item.minutesToReply % 25) / 100,
      },
    });
    store.updateConversation(conversation.id, { category: store.draft(draft.id)!.analysis!.category });
    const sender = team[item.teammate]!;
    const outcome = await sendReply({
      store,
      providerFor: () => provider,
      user: sender,
      conversationId: conversation.id,
      draftId: draft.id,
      body: item.sent,
      key: `seed-${item.hint}`,
    });
    const repliedAt = iso(askedAt + item.minutesToReply * 60_000);
    store.db.query("UPDATE messages SET sent_at = ? WHERE conversation_id = ? AND direction = 'outbound'").run(repliedAt, conversation.id);
    store.db.query("UPDATE sends SET created_at = ? WHERE id = ?").run(repliedAt, outcome.sendId);
    store.db.query("UPDATE drafts SET created_at = ?, updated_at = ? WHERE id = ?").run(iso(askedAt + 60_000), repliedAt, draft.id);
    store.db
      .query("UPDATE conversations SET last_message_at = ?, status = 'closed', unread = 0, assignee_id = ? WHERE id = ?")
      .run(repliedAt, sender.id, conversation.id);
    await learnFromEdit({ store, model, draftId: draft.id });
  }

  await syncMailbox({ store, mailbox: store.mailbox(mailbox.id)!, provider });
  for (let draft = store.claimQueuedDraft(); draft; draft = store.claimQueuedDraft()) {
    await generateDraft({ store, model, classifier: new ModelClassifier(model), draftId: draft.id, now: () => new Date(now) });
  }

  const open = store.listConversations({ view: "open" });
  const assign = (subject: RegExp, member: number) => {
    const conversation = open.find((item) => subject.test(item.subject));
    if (conversation) store.updateConversation(conversation.id, { assigneeId: team[member]!.id });
    return conversation;
  };
  assign(/not here/, 0);
  assign(/cracked/, 0);
  assign(/Charged twice/, 1);
  const refund = assign(/refund/i, 2);
  assign(/Wholesale/, 1);
  for (const conversation of open.filter((item) => /vase|Dishwasher/.test(item.subject))) {
    store.updateConversation(conversation.id, { unread: false });
  }
  if (refund) {
    store.addReminder({ conversationId: refund.id, dueAt: iso(now + 86_400_000), note: "Check that the refund posted.", createdBy: team[2]!.id });
  }
  const failing = open.find((item) => /Canada/.test(item.subject));
  const failingDraft = failing ? store.currentDraft(failing.id) : null;
  if (failingDraft) store.updateDraft(failingDraft.id, { state: "failed", error: "The model took too long to answer. Try again." });
  store.notify({ userId: team[0]!.id, kind: "assigned", conversationId: open[0]?.id ?? null, text: "Priya assigned you \"Order #1042 still not here\"." });
}
