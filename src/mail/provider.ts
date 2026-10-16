import type { Address, ProviderKind } from "../core/types";

export type PulledAttachment = {
  filename: string;
  mimeType: string;
  content: Uint8Array;
};

/** One message as a provider reports it, before it is matched to a conversation. */
export type PulledMessage = {
  externalId: string;
  threadHint: string | null;
  messageIdHeader: string;
  inReplyTo: string;
  references: string[];
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  text: string;
  sentAt: string;
  attachments: PulledAttachment[];
};

export type PullResult = { messages: PulledMessage[]; cursor: string };

export type OutgoingMail = {
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  text: string;
  html: string;
  inReplyTo?: string;
  references?: string[];
  threadHint?: string | null;
};

export type SentMail = { externalId: string; messageIdHeader: string; threadHint: string | null };

/**
 * The only contract the inbox depends on. `pull` returns messages newer than the
 * cursor (a null cursor means first sync) and the cursor to store. `send` either
 * resolves after the provider accepted the message or throws.
 */
export interface MailProvider {
  readonly kind: ProviderKind;
  readonly address: string;
  pull(cursor: string | null): Promise<PullResult>;
  send(mail: OutgoingMail): Promise<SentMail>;
}

/** Thrown when the provider rejected the request before anything was sent. */
export class SendRejectedError extends Error {
  override name = "SendRejectedError";
}
