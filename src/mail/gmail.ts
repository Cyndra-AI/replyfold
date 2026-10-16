import { z } from "zod";
import { buildMime, parseAddress, parseAddressList } from "./mime";
import type { MailProvider, OutgoingMail, PulledAttachment, PulledMessage, PullResult, SentMail } from "./provider";
import { SendRejectedError } from "./provider";
import { htmlToText } from "./text";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const FIRST_SYNC_QUERY = "-in:spam -in:trash -in:draft newer_than:14d";
const MAX_FIRST_SYNC = 200;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
};

export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailPart;
};

const historyPage = z.object({
  history: z
    .array(z.object({ messagesAdded: z.array(z.object({ message: z.object({ id: z.string() }) })).optional() }))
    .optional(),
  historyId: z.string().optional(),
  nextPageToken: z.string().optional(),
});
const listPage = z.object({
  messages: z.array(z.object({ id: z.string() })).optional(),
  nextPageToken: z.string().optional(),
});

export class GmailHistoryExpiredError extends Error {}

function header(part: GmailPart | undefined, name: string) {
  const lower = name.toLowerCase();
  return part?.headers?.find((entry) => entry.name.toLowerCase() === lower)?.value?.trim() ?? "";
}

function walk(part: GmailPart, visit: (part: GmailPart) => void) {
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}

function decode(data: string | undefined) {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

/** Maps one Gmail API message to the provider-neutral shape. Attachments are fetched separately. */
export function mapGmailMessage(message: GmailMessage): { message: PulledMessage; attachmentRefs: Array<{ id: string; filename: string; mimeType: string }> } | null {
  const labels = message.labelIds ?? [];
  if (labels.includes("DRAFT") || labels.includes("SPAM") || labels.includes("TRASH") || !message.payload) return null;
  let text = "";
  let html = "";
  const attachmentRefs: Array<{ id: string; filename: string; mimeType: string }> = [];
  walk(message.payload, (part) => {
    const mime = (part.mimeType ?? "").toLowerCase();
    if (part.filename && part.body?.attachmentId) {
      if ((part.body.size ?? 0) <= MAX_ATTACHMENT_BYTES) {
        attachmentRefs.push({ id: part.body.attachmentId, filename: part.filename, mimeType: mime || "application/octet-stream" });
      }
      return;
    }
    if (mime === "text/plain" && !text) text = decode(part.body?.data);
    if (mime === "text/html" && !html) html = decode(part.body?.data);
  });
  const payload = message.payload;
  const time = Number(message.internalDate);
  return {
    attachmentRefs,
    message: {
      externalId: message.id,
      threadHint: message.threadId,
      messageIdHeader: header(payload, "Message-ID"),
      inReplyTo: header(payload, "In-Reply-To"),
      references: header(payload, "References").split(/\s+/).filter(Boolean),
      from: parseAddress(header(payload, "From")),
      to: parseAddressList(header(payload, "To")),
      cc: parseAddressList(header(payload, "Cc")),
      subject: header(payload, "Subject"),
      text: text || htmlToText(html),
      sentAt: new Date(Number.isFinite(time) && time > 0 ? time : Date.now()).toISOString(),
      attachments: [],
    },
  };
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class GmailProvider implements MailProvider {
  readonly kind = "gmail" as const;

  constructor(
    readonly address: string,
    private readonly accessToken: () => Promise<string>,
    private readonly fetcher: Fetch = fetch,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(`${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404 && path.startsWith("/history")) throw new GmailHistoryExpiredError("Gmail history expired");
    if (!response.ok) throw new Error(`Gmail returned HTTP ${response.status} for ${path.split("?")[0]}`);
    return (await response.json()) as T;
  }

  private async fetchMessage(id: string): Promise<PulledMessage | null> {
    const raw = await this.call<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=full`);
    const mapped = mapGmailMessage(raw);
    if (!mapped) return null;
    const attachments: PulledAttachment[] = [];
    for (const ref of mapped.attachmentRefs) {
      const body = await this.call<{ data: string }>(
        `/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(ref.id)}`,
      );
      attachments.push({ filename: ref.filename, mimeType: ref.mimeType, content: new Uint8Array(Buffer.from(body.data, "base64url")) });
    }
    return { ...mapped.message, attachments };
  }

  private async firstSync(): Promise<PullResult> {
    const profile = await this.call<{ historyId: string }>("/profile");
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ q: FIRST_SYNC_QUERY, maxResults: "100", ...(pageToken ? { pageToken } : {}) });
      const page = listPage.parse(await this.call(`/messages?${query}`));
      for (const entry of page.messages ?? []) ids.push(entry.id);
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < MAX_FIRST_SYNC);
    return { messages: await this.fetchAll(ids.slice(0, MAX_FIRST_SYNC)), cursor: profile.historyId };
  }

  private async fetchAll(ids: string[]) {
    const messages: PulledMessage[] = [];
    for (const id of ids) {
      const message = await this.fetchMessage(id);
      if (message) messages.push(message);
    }
    return messages;
  }

  async pull(cursor: string | null): Promise<PullResult> {
    if (!cursor) return this.firstSync();
    const ids = new Set<string>();
    let newest = cursor;
    let pageToken: string | undefined;
    try {
      do {
        const query = new URLSearchParams({ startHistoryId: cursor, historyTypes: "messageAdded", ...(pageToken ? { pageToken } : {}) });
        const page = historyPage.parse(await this.call(`/history?${query}`));
        for (const record of page.history ?? []) for (const added of record.messagesAdded ?? []) ids.add(added.message.id);
        if (page.historyId) newest = page.historyId;
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (error) {
      if (error instanceof GmailHistoryExpiredError) return this.firstSync();
      throw error;
    }
    return { messages: await this.fetchAll([...ids]), cursor: newest };
  }

  async send(mail: OutgoingMail): Promise<SentMail> {
    const raw = buildMime(mail);
    const response = await this.fetcher(`${API}/messages/send`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ raw: Buffer.from(raw).toString("base64url"), ...(mail.threadHint ? { threadId: mail.threadHint } : {}) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 400 && response.status < 500) throw new SendRejectedError(`Gmail refused the message (HTTP ${response.status}).`);
    if (!response.ok) throw new Error(`Gmail returned HTTP ${response.status} while sending.`);
    const sent = z.object({ id: z.string(), threadId: z.string() }).parse(await response.json());
    return { externalId: sent.id, messageIdHeader: mail.messageIdHeader, threadHint: sent.threadId };
  }
}
