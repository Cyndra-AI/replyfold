export const ROLES = ["owner", "lead", "agent"] as const;
export type Role = (typeof ROLES)[number];

export const PROVIDER_KINDS = ["gmail", "microsoft", "imap", "demo"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const CONVERSATION_STATUSES = ["open", "waiting", "closed"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const DRAFT_STATES = ["queued", "generating", "ready", "failed", "sent", "discarded"] as const;
export type DraftState = (typeof DRAFT_STATES)[number];

export const SEND_STATES = ["staged", "sent", "failed", "uncertain"] as const;
export type SendState = (typeof SEND_STATES)[number];

export const DISCARD_REASONS = ["wrong_facts", "wrong_tone", "missing_info", "not_needed", "superseded", "other"] as const;
export type DiscardReason = (typeof DISCARD_REASONS)[number];

export const EDIT_CLASSES = ["unchanged", "light", "heavy"] as const;
export type EditClass = (typeof EDIT_CLASSES)[number];

export const CATEGORIES = ["shipping", "billing", "returns", "account", "product", "feedback", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export const MOODS = ["happy", "calm", "confused", "worried", "frustrated", "angry"] as const;
export type Mood = (typeof MOODS)[number];

export type Address = { name: string; email: string };

export type User = {
  id: string;
  email: string;
  name: string;
  role: Role;
  signature: string;
  createdAt: string;
};

export type Mailbox = {
  id: string;
  provider: ProviderKind;
  address: string;
  displayName: string;
  status: "active" | "error" | "paused";
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
};

export type Conversation = {
  id: string;
  mailboxId: string;
  subject: string;
  customer: Address;
  status: ConversationStatus;
  assigneeId: string | null;
  category: Category;
  /** The customer's mood in their latest email, or null when it was not classified. */
  mood: Mood | null;
  lastMessageAt: string;
  lastInboundAt: string | null;
  snippet: string;
  unread: boolean;
};

export type Attachment = {
  id: string;
  messageId: string;
  filename: string;
  mimeType: string;
  size: number;
};

export type Message = {
  id: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  text: string;
  sentAt: string;
  messageIdHeader: string;
  attachments: Attachment[];
  sentByUserId: string | null;
  mood: Mood | null;
};

export type DraftAnalysis = {
  summary: string;
  intent: string;
  category: Category;
  disposition: "reply" | "no_reply";
  needsHuman: boolean;
  missingInformation: string[];
  facts: Array<{ claim: string; evidence: string[] }>;
  confidence: number;
};

export type ValidationIssue = { code: string; message: string };

export type Draft = {
  id: string;
  conversationId: string;
  forMessageId: string;
  state: DraftState;
  body: string;
  analysis: DraftAnalysis | null;
  issues: ValidationIssue[];
  error: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  sentBody: string | null;
  editClass: EditClass | null;
  discardReason: DiscardReason | null;
};

export type Send = {
  id: string;
  conversationId: string;
  draftId: string | null;
  state: SendState;
  body: string;
  error: string | null;
  userId: string;
  createdAt: string;
};

export type PlaybookVersion = { id: string; content: string; note: string; savedBy: string | null; savedAt: string };

export type Lesson = {
  id: string;
  draftId: string;
  category: string;
  summary: string;
  rule: string;
  createdAt: string;
};

export type Suggestion = {
  id: string;
  rule: string;
  rationale: string;
  lessonIds: string[];
  state: "pending" | "accepted" | "rejected";
  createdAt: string;
};

export type Reminder = {
  id: string;
  conversationId: string;
  dueAt: string;
  note: string;
  doneAt: string | null;
  createdBy: string | null;
};

export type Notification = {
  id: string;
  userId: string;
  kind: "assigned" | "draft_failed" | "reminder_due" | "send_uncertain";
  conversationId: string | null;
  text: string;
  readAt: string | null;
  createdAt: string;
};
