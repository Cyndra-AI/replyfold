import type { Mailbox } from "../core/types";
import type { Store } from "../db/store";
import type { MailProvider, PulledMessage } from "./provider";
import { visibleText } from "./text";

export type SyncResult = { ok: true; added: number; draftsQueued: number } | { ok: false; error: string };

function conversationFor(store: Store, mailbox: Mailbox, message: PulledMessage, inbound: boolean) {
  const existing =
    (message.threadHint && store.conversationByHint(mailbox.id, message.threadHint)) ||
    store.conversationByHeaders(mailbox.id, [message.inReplyTo, ...message.references]);
  if (existing) return existing;
  const customer = inbound ? message.from : (message.to[0] ?? message.from);
  return store.createConversation({
    mailboxId: mailbox.id,
    threadHint: message.threadHint,
    subject: message.subject.replace(/^(re|fwd?)\s*:\s*/i, "") || "(no subject)",
    customer,
    at: message.sentAt,
  });
}

/**
 * Pulls new mail for one mailbox and files it. Matching order: the provider's
 * thread id, then In-Reply-To and References, then a new conversation. A customer
 * message that ends up newest in its conversation queues a fresh draft and
 * retires drafts for older messages. The cursor only advances after every message
 * is stored, so a crash replays the page and duplicate ids are skipped.
 */
export async function syncMailbox(input: { store: Store; mailbox: Mailbox; provider: MailProvider }): Promise<SyncResult> {
  const { store, mailbox, provider } = input;
  const cursor = store.mailboxSecrets(mailbox.id)?.cursor ?? null;
  let page;
  try {
    page = await provider.pull(cursor);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.updateMailbox(mailbox.id, { status: "error", lastError: message, lastSyncAt: new Date().toISOString() });
    return { ok: false, error: message };
  }

  const own = mailbox.address.toLowerCase();
  const ordered = [...page.messages].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  const touched = new Set<string>();
  let added = 0;

  store.transaction(() => {
    for (const pulled of ordered) {
      if (store.hasMessage(mailbox.id, pulled.externalId)) continue;
      const inbound = pulled.from.email.toLowerCase() !== own;
      const conversation = conversationFor(store, mailbox, pulled, inbound);
      const stored = store.insertMessage({
        conversationId: conversation.id,
        mailboxId: mailbox.id,
        externalId: pulled.externalId,
        direction: inbound ? "inbound" : "outbound",
        from: pulled.from,
        to: pulled.to,
        cc: pulled.cc,
        subject: pulled.subject,
        text: visibleText(pulled.text),
        sentAt: pulled.sentAt,
        messageIdHeader: pulled.messageIdHeader,
        references: pulled.references,
        attachments: pulled.attachments,
      });
      if (!stored) continue;
      added += 1;
      touched.add(conversation.id);
    }
  });

  let draftsQueued = 0;
  for (const conversationId of touched) {
    const messages = store.messages(conversationId);
    const latest = messages[messages.length - 1];
    if (!latest || latest.direction !== "inbound") continue;
    const current = store.currentDraft(conversationId);
    if (current && current.forMessageId === latest.id) continue;
    store.supersedeDrafts(conversationId, latest.id);
    store.createDraft({ conversationId, forMessageId: latest.id });
    draftsQueued += 1;
  }

  store.updateMailbox(mailbox.id, { cursor: page.cursor, status: "active", lastError: null, lastSyncAt: new Date().toISOString() });
  return { ok: true, added, draftsQueued };
}
