import type {
  Category,
  Conversation,
  ConversationStatus,
  DiscardReason,
  Draft,
  DraftState,
  Lesson,
  Mailbox,
  Message,
  Notification,
  PlaybookVersion,
  Reminder,
  Send,
  SendState,
  Suggestion,
  User,
} from "../../core/types";
import type { ImapPreset } from "../../mail/presets";
import type { Stats } from "../../stats";

export type { Category, Conversation, ConversationStatus, DiscardReason, Draft, DraftState, Mailbox, Message, User };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok && response.status !== 502) throw new ApiError(response.status, data.error ?? `Request failed (${response.status}).`);
  return data as T;
}

export type InboxView = "mine" | "unassigned" | "open" | "waiting" | "closed" | "all";

export type InboxRow = Conversation & { draft: { state: DraftState; issues: number; needsHuman: boolean } | null };

export type InboxResponse = { conversations: InboxRow[]; counts: Record<InboxView, number> };

export type ConversationResponse = {
  conversation: Conversation;
  mailbox: Mailbox | null;
  messages: Message[];
  draft: Draft | null;
  sends: Send[];
  reminders: Reminder[];
};

export type SessionResponse = { user: User | null; setupRequired: boolean; demo: { email: string; password: string } | null };

export type SendOutcome = { sendId: string; conversationId: string; state: SendState; error: string | null };

export type PlaybookResponse = { current: PlaybookVersion | null; versions: PlaybookVersion[]; suggestions: Suggestion[]; lessons: Lesson[] };

export type MailboxesResponse = {
  mailboxes: Mailbox[];
  oauth: { gmail: boolean; microsoft: boolean };
  redirectUris: { gmail: string; microsoft: string };
  presets: ImapPreset[];
  model: { name: string; kind: string };
};

export type { Notification, Stats, ImapPreset };

export const newKey = () => crypto.randomUUID();
