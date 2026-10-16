import { z } from "zod";
import type { MailProvider, OutgoingMail, PulledMessage, PullResult, SentMail } from "./provider";
import { SendRejectedError } from "./provider";
import { htmlToText } from "./text";

const GRAPH = "https://graph.microsoft.com/v1.0";
const FOLDERS = ["inbox", "sentitems"] as const;
const SELECT = "id,conversationId,internetMessageId,subject,from,toRecipients,ccRecipients,body,receivedDateTime,sentDateTime,hasAttachments,isDraft";
const FIRST_SYNC_DAYS = 14;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const recipient = z.object({ emailAddress: z.object({ name: z.string().nullish(), address: z.string().nullish() }) });
const graphMessage = z.object({
  id: z.string(),
  "@removed": z.unknown().optional(),
  conversationId: z.string().nullish(),
  internetMessageId: z.string().nullish(),
  subject: z.string().nullish(),
  from: recipient.nullish(),
  toRecipients: z.array(recipient).nullish(),
  ccRecipients: z.array(recipient).nullish(),
  body: z.object({ contentType: z.string(), content: z.string() }).nullish(),
  receivedDateTime: z.string().nullish(),
  sentDateTime: z.string().nullish(),
  hasAttachments: z.boolean().nullish(),
  isDraft: z.boolean().nullish(),
});
export type GraphMessage = z.infer<typeof graphMessage>;

const deltaPage = z.object({
  value: z.array(graphMessage),
  "@odata.nextLink": z.string().optional(),
  "@odata.deltaLink": z.string().optional(),
});
const attachmentList = z.object({
  value: z.array(
    z.object({
      "@odata.type": z.string(),
      name: z.string().nullish(),
      contentType: z.string().nullish(),
      size: z.number().nullish(),
      contentBytes: z.string().nullish(),
      isInline: z.boolean().nullish(),
    }),
  ),
});

type Cursor = Partial<Record<(typeof FOLDERS)[number], string>>;

const toAddress = (entry: z.infer<typeof recipient> | null | undefined) => ({
  name: entry?.emailAddress.name?.trim() ?? "",
  email: entry?.emailAddress.address?.trim().toLowerCase() ?? "",
});

/** Maps one Graph message to the provider-neutral shape. Removed items and drafts map to null. */
export function mapGraphMessage(message: GraphMessage): PulledMessage | null {
  if (message["@removed"] !== undefined || message.isDraft) return null;
  const body = message.body;
  const text = !body ? "" : body.contentType.toLowerCase() === "html" ? htmlToText(body.content) : body.content.trim();
  return {
    externalId: message.id,
    threadHint: message.conversationId ?? null,
    messageIdHeader: message.internetMessageId ?? "",
    inReplyTo: "",
    references: [],
    from: toAddress(message.from),
    to: (message.toRecipients ?? []).map(toAddress),
    cc: (message.ccRecipients ?? []).map(toAddress),
    subject: message.subject ?? "",
    text,
    sentAt: new Date(message.receivedDateTime ?? message.sentDateTime ?? Date.now()).toISOString(),
    attachments: [],
  };
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class MicrosoftProvider implements MailProvider {
  readonly kind = "microsoft" as const;

  constructor(
    readonly address: string,
    private readonly accessToken: () => Promise<string>,
    private readonly fetcher: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async request(url: string, init: RequestInit = {}) {
    return this.fetcher(url.startsWith("http") ? url : `${GRAPH}${url}`, {
      ...init,
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        "content-type": "application/json",
        prefer: 'IdType="ImmutableId", odata.maxpagesize=50',
        ...init.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });
  }

  private async json(url: string) {
    const response = await this.request(url);
    if (!response.ok) throw new Error(`Microsoft Graph returned HTTP ${response.status}.`);
    return response.json();
  }

  private firstLink(folder: string) {
    const since = new Date(this.now() - FIRST_SYNC_DAYS * 86_400_000).toISOString();
    const filter = encodeURIComponent(`receivedDateTime ge ${since}`);
    return `/me/mailFolders/${folder}/messages/delta?$select=${SELECT}&$filter=${filter}`;
  }

  private async attachments(id: string) {
    const list = attachmentList.parse(await this.json(`/me/messages/${encodeURIComponent(id)}/attachments`));
    return list.value
      .filter((item) => item["@odata.type"] === "#microsoft.graph.fileAttachment" && item.contentBytes && (item.size ?? 0) <= MAX_ATTACHMENT_BYTES)
      .map((item) => ({
        filename: item.name ?? "attachment",
        mimeType: item.contentType ?? "application/octet-stream",
        content: new Uint8Array(Buffer.from(item.contentBytes!, "base64")),
      }));
  }

  async pull(cursor: string | null): Promise<PullResult> {
    const links: Cursor = cursor ? (JSON.parse(cursor) as Cursor) : {};
    const next: Cursor = {};
    const messages: PulledMessage[] = [];
    for (const folder of FOLDERS) {
      let link: string | undefined = links[folder] ?? this.firstLink(folder);
      while (link) {
        const page = deltaPage.parse(await this.json(link));
        for (const item of page.value) {
          const mapped = mapGraphMessage(item);
          if (!mapped) continue;
          messages.push(item.hasAttachments ? { ...mapped, attachments: await this.attachments(item.id) } : mapped);
        }
        if (page["@odata.deltaLink"]) next[folder] = page["@odata.deltaLink"];
        link = page["@odata.nextLink"];
      }
    }
    return { messages, cursor: JSON.stringify(next) };
  }

  /**
   * Replies through createReply so Outlook keeps the conversation, then sends the
   * draft. Immutable ids keep the draft id after it moves to Sent Items, so the next
   * sync recognizes the sent copy.
   */
  async send(mail: OutgoingMail): Promise<SentMail> {
    const payload = {
      subject: mail.subject,
      body: { contentType: "HTML", content: mail.html },
      toRecipients: mail.to.map((entry) => ({ emailAddress: { address: entry.email, name: entry.name } })),
      ccRecipients: mail.cc.map((entry) => ({ emailAddress: { address: entry.email, name: entry.name } })),
      bccRecipients: mail.bcc.map((entry) => ({ emailAddress: { address: entry.email, name: entry.name } })),
    };
    const created = mail.replyToExternalId
      ? await this.request(`/me/messages/${encodeURIComponent(mail.replyToExternalId)}/createReply`, { method: "POST", body: "{}" })
      : await this.request("/me/messages", { method: "POST", body: JSON.stringify(payload) });
    if (created.status >= 400 && created.status < 500) throw new SendRejectedError(`Microsoft refused the message (HTTP ${created.status}).`);
    if (!created.ok) throw new Error(`Microsoft Graph returned HTTP ${created.status} while preparing the message.`);
    const draft = z.object({ id: z.string(), conversationId: z.string().nullish(), internetMessageId: z.string().nullish() }).parse(await created.json());
    if (mail.replyToExternalId) {
      const patched = await this.request(`/me/messages/${encodeURIComponent(draft.id)}`, { method: "PATCH", body: JSON.stringify(payload) });
      if (!patched.ok) throw new SendRejectedError(`Microsoft refused the reply text (HTTP ${patched.status}).`);
    }
    const sent = await this.request(`/me/messages/${encodeURIComponent(draft.id)}/send`, { method: "POST", body: "{}" });
    if (sent.status >= 400 && sent.status < 500) throw new SendRejectedError(`Microsoft refused to send (HTTP ${sent.status}).`);
    if (!sent.ok) throw new Error(`Microsoft Graph returned HTTP ${sent.status} while sending.`);
    return { externalId: draft.id, messageIdHeader: draft.internetMessageId ?? mail.messageIdHeader, threadHint: draft.conversationId ?? null };
  }
}
