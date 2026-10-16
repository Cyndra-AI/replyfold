import type { Address, SendState, User } from "../core/types";
import type { Store } from "../db/store";
import { newMessageId, replySubject } from "../mail/mime";
import { SendRejectedError, type MailProvider, type OutgoingMail } from "../mail/provider";
import { classifyEdit } from "./edits";

export type SendOutcome = { sendId: string; conversationId: string; state: SendState; error: string | null };

export type ProviderFor = (mailboxId: string) => MailProvider;

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderHtml(text: string) {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => {
      const linked = escapeHtml(paragraph).replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}">${url}</a>`);
      return `<p>${linked.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");
}

function withSignature(body: string, signature: string) {
  const text = body.trim();
  return signature.trim() ? `${text}\n\n${signature.trim()}` : text;
}

const UNCERTAIN = "This email may already have been sent. Check the mailbox's Sent folder before you try again.";

/**
 * Stage, send, record. The idempotency key makes a double click or a retried
 * request return the first outcome. A provider refusal is a clean failure. Any
 * other error after the request left could mean the email went out, so the send is
 * marked uncertain and a person must check before retrying.
 */
async function deliver(input: {
  store: Store;
  provider: MailProvider;
  user: User;
  conversationId: string;
  draftId: string | null;
  mail: OutgoingMail;
  body: string;
  key: string;
}): Promise<SendOutcome> {
  const { store, user, conversationId } = input;
  const staged = store.stageSend({ conversationId, draftId: input.draftId, key: input.key, body: input.body, userId: user.id });
  if (!staged.fresh) return { sendId: staged.send.id, conversationId, state: staged.send.state, error: staged.send.error };

  let sent;
  try {
    sent = await input.provider.send(input.mail);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SendRejectedError) {
      store.updateSend(staged.send.id, "failed", message);
      return { sendId: staged.send.id, conversationId, state: "failed", error: message };
    }
    store.updateSend(staged.send.id, "uncertain", message);
    store.notify({ userId: user.id, kind: "send_uncertain", conversationId, text: UNCERTAIN });
    return { sendId: staged.send.id, conversationId, state: "uncertain", error: UNCERTAIN };
  }

  const mailbox = store.conversation(conversationId)!.mailboxId;
  store.transaction(() => {
    store.updateSend(staged.send.id, "sent");
    store.insertMessage({
      conversationId,
      mailboxId: mailbox,
      externalId: sent.externalId,
      direction: "outbound",
      from: input.mail.from,
      to: input.mail.to,
      cc: input.mail.cc,
      subject: input.mail.subject,
      text: input.mail.text,
      sentAt: new Date().toISOString(),
      messageIdHeader: sent.messageIdHeader,
      references: input.mail.references ?? [],
      sentByUserId: user.id,
    });
    store.updateConversation(conversationId, { status: "waiting", unread: false });
    if (input.draftId) {
      const draft = store.draft(input.draftId);
      if (draft) store.updateDraft(draft.id, { state: "sent", sentBody: input.body, editClass: classifyEdit(draft.body, input.body) });
    }
  });
  return { sendId: staged.send.id, conversationId, state: "sent", error: null };
}

export async function sendReply(input: {
  store: Store;
  providerFor: ProviderFor;
  user: User;
  conversationId: string;
  draftId: string | null;
  body: string;
  key: string;
}): Promise<SendOutcome> {
  const { store } = input;
  const conversation = store.conversation(input.conversationId);
  if (!conversation) throw new Error("This conversation no longer exists.");
  const mailbox = store.mailbox(conversation.mailboxId);
  if (!mailbox) throw new Error("This conversation's mailbox was disconnected.");
  const messages = store.messages(conversation.id);
  const target = [...messages].reverse().find((message) => message.direction === "inbound") ?? messages.at(-1);
  const own = mailbox.address.toLowerCase();
  const to: Address[] = target && target.direction === "inbound" ? [target.from] : [conversation.customer];
  const cc = (target?.cc ?? []).filter((entry) => entry.email !== own && !to.some((item) => item.email === entry.email));
  const references = target ? [...store.messageReferences(target.id), target.messageIdHeader].filter(Boolean) : [];
  const text = withSignature(input.body, input.user.signature);
  const mail: OutgoingMail = {
    from: { name: mailbox.displayName, email: mailbox.address },
    to,
    cc,
    bcc: [],
    subject: replySubject(target?.subject || conversation.subject),
    text,
    html: renderHtml(text),
    messageIdHeader: newMessageId(mailbox.address),
    inReplyTo: target?.messageIdHeader || undefined,
    references,
    threadHint: store.conversationThreadHint(conversation.id),
    replyToExternalId: target ? store.messageExternalId(target.id) : undefined,
  };
  return deliver({ ...input, provider: input.providerFor(mailbox.id), mail });
}

export async function composeNew(input: {
  store: Store;
  providerFor: ProviderFor;
  user: User;
  mailboxId: string;
  to: Address[];
  cc: Address[];
  subject: string;
  body: string;
  key: string;
}): Promise<SendOutcome> {
  const { store } = input;
  const mailbox = store.mailbox(input.mailboxId);
  if (!mailbox) throw new Error("Choose a connected mailbox to send from.");
  const first = input.to[0];
  if (!first) throw new Error("Add at least one recipient.");
  const conversation = store.createConversation({
    mailboxId: mailbox.id,
    threadHint: null,
    subject: input.subject.trim() || "(no subject)",
    customer: first,
    at: new Date().toISOString(),
  });
  const text = withSignature(input.body, input.user.signature);
  const outcome = await deliver({
    store,
    provider: input.providerFor(mailbox.id),
    user: input.user,
    conversationId: conversation.id,
    draftId: null,
    body: input.body,
    key: input.key,
    mail: {
      from: { name: mailbox.displayName, email: mailbox.address },
      to: input.to,
      cc: input.cc,
      bcc: [],
      subject: input.subject.trim(),
      text,
      html: renderHtml(text),
      messageIdHeader: newMessageId(mailbox.address),
    },
  });
  if (outcome.state === "failed") store.updateConversation(conversation.id, { status: "closed" });
  return outcome;
}
