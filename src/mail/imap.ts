import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import nodemailer from "nodemailer";
import { z } from "zod";
import type { Address } from "../core/types";
import { buildMime } from "./mime";
import type { MailProvider, OutgoingMail, PulledMessage, PullResult, SentMail } from "./provider";
import { SendRejectedError } from "./provider";
import { htmlToText } from "./text";

const FIRST_SYNC_DAYS = 14;
const MAX_FIRST_SYNC = 200;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const ImapSettingsSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
  imap: z.object({ host: z.string().trim().min(1), port: z.coerce.number().int().positive(), secure: z.boolean() }),
  smtp: z.object({ host: z.string().trim().min(1), port: z.coerce.number().int().positive(), secure: z.boolean() }),
});
export type ImapSettings = z.infer<typeof ImapSettingsSchema>;

/** The few IMAP operations the provider needs. The real one wraps imapflow; tests use a fake. */
export interface ImapSession {
  openInbox(): Promise<{ uidValidity: string; uidNext: number }>;
  searchSince(since: Date): Promise<number[]>;
  fetchSources(uids: number[] | { from: number }): AsyncIterable<{ uid: number; source: Buffer }>;
  appendSent(raw: string): Promise<void>;
  close(): Promise<void>;
}

export type SmtpSender = (envelope: { from: string; to: string[] }, raw: string) => Promise<void>;

function addresses(value: AddressObject | AddressObject[] | undefined): Address[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.flatMap((entry) =>
    entry.value.filter((item) => item.address).map((item) => ({ name: item.name ?? "", email: item.address!.toLowerCase() })),
  );
}

/** Parses an RFC 5322 message from an IMAP server into the provider-neutral shape. */
export async function parseRawMessage(raw: Buffer, externalId: string): Promise<PulledMessage> {
  const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
  return {
    externalId,
    threadHint: null,
    messageIdHeader: parsed.messageId ?? "",
    inReplyTo: parsed.inReplyTo ?? "",
    references,
    from: addresses(parsed.from)[0] ?? { name: "", email: "" },
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    subject: parsed.subject ?? "",
    text: parsed.text?.trim() || (typeof parsed.html === "string" ? htmlToText(parsed.html) : ""),
    sentAt: (parsed.date ?? new Date()).toISOString(),
    attachments: parsed.attachments
      .filter((item) => item.contentDisposition !== "inline" && item.size <= MAX_ATTACHMENT_BYTES)
      .map((item) => ({
        filename: item.filename ?? "attachment",
        mimeType: item.contentType || "application/octet-stream",
        content: new Uint8Array(item.content),
      })),
  };
}

const cursorSchema = z.object({ uidValidity: z.string(), lastUid: z.number().int().nonnegative() });

export class ImapProvider implements MailProvider {
  readonly kind = "imap" as const;

  constructor(
    readonly address: string,
    private readonly connect: () => Promise<ImapSession>,
    private readonly smtp: SmtpSender,
    private readonly now: () => number = Date.now,
  ) {}

  async pull(cursor: string | null): Promise<PullResult> {
    const session = await this.connect();
    try {
      const state = await session.openInbox();
      const previous = cursor ? cursorSchema.safeParse(JSON.parse(cursor)) : null;
      const resume = previous?.success && previous.data.uidValidity === state.uidValidity ? previous.data : null;
      const range: number[] | { from: number } = resume
        ? { from: resume.lastUid + 1 }
        : (await session.searchSince(new Date(this.now() - FIRST_SYNC_DAYS * 86_400_000))).slice(-MAX_FIRST_SYNC);
      let lastUid = resume?.lastUid ?? Math.max(0, state.uidNext - 1);
      const messages: PulledMessage[] = [];
      if (Array.isArray(range) && !range.length) {
        return { messages, cursor: JSON.stringify({ uidValidity: state.uidValidity, lastUid }) };
      }
      for await (const item of session.fetchSources(range)) {
        if (resume && item.uid <= resume.lastUid) continue;
        messages.push(await parseRawMessage(item.source, `${state.uidValidity}:${item.uid}`));
        lastUid = Math.max(lastUid, item.uid);
      }
      return { messages, cursor: JSON.stringify({ uidValidity: state.uidValidity, lastUid }) };
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  async send(mail: OutgoingMail): Promise<SentMail> {
    const raw = buildMime(mail);
    const recipients = [...mail.to, ...mail.cc, ...mail.bcc].map((entry) => entry.email);
    try {
      await this.smtp({ from: mail.from.email, to: recipients }, raw);
    } catch (error) {
      const code = (error as { responseCode?: number }).responseCode;
      if (code && code >= 500) throw new SendRejectedError(`The mail server refused the message (${code}).`);
      throw error;
    }
    const session = await this.connect().catch(() => null);
    if (session) {
      await session.appendSent(raw).catch(() => undefined);
      await session.close().catch(() => undefined);
    }
    return { externalId: `sent:${mail.messageIdHeader}`, messageIdHeader: mail.messageIdHeader, threadHint: null };
  }
}

export function imapflowSession(settings: ImapSettings): () => Promise<ImapSession> {
  return async () => {
    const client = new ImapFlow({
      host: settings.imap.host,
      port: settings.imap.port,
      secure: settings.imap.secure,
      auth: { user: settings.username, pass: settings.password },
      logger: false,
    });
    await client.connect();
    let release: (() => void) | null = null;
    return {
      async openInbox() {
        const lock = await client.getMailboxLock("INBOX");
        release = () => lock.release();
        const mailbox = client.mailbox;
        if (!mailbox) throw new Error("The INBOX folder could not be opened.");
        return { uidValidity: String(mailbox.uidValidity), uidNext: mailbox.uidNext };
      },
      async searchSince(since) {
        const uids = await client.search({ since }, { uid: true });
        return Array.isArray(uids) ? uids : [];
      },
      async *fetchSources(uids) {
        const range = Array.isArray(uids) ? uids.join(",") : `${uids.from}:*`;
        for await (const message of client.fetch(range, { uid: true, source: true }, { uid: true })) {
          if (message.source) yield { uid: message.uid, source: message.source };
        }
      },
      async appendSent(raw) {
        const folders = await client.list();
        const sent = folders.find((folder) => folder.specialUse === "\\Sent");
        if (sent) await client.append(sent.path, raw, ["\\Seen"]);
      },
      async close() {
        release?.();
        await client.logout();
      },
    };
  };
}

export function smtpSender(settings: ImapSettings): SmtpSender {
  const transport = nodemailer.createTransport({
    host: settings.smtp.host,
    port: settings.smtp.port,
    secure: settings.smtp.secure,
    auth: { user: settings.username, pass: settings.password },
  });
  return async (envelope, raw) => {
    await transport.sendMail({ envelope, raw });
  };
}

/** Logs in to both servers so a wrong password fails at connect time, not at first sync. */
export async function verifyImapSettings(settings: ImapSettings) {
  const session = await imapflowSession(settings)();
  await session.openInbox();
  await session.close();
  await nodemailer
    .createTransport({
      host: settings.smtp.host,
      port: settings.smtp.port,
      secure: settings.smtp.secure,
      auth: { user: settings.username, pass: settings.password },
    })
    .verify();
}
