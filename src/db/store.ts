import { Database } from "bun:sqlite";
import type {
  Address,
  Attachment,
  Category,
  Conversation,
  ConversationStatus,
  DiscardReason,
  Draft,
  DraftAnalysis,
  DraftState,
  EditClass,
  Lesson,
  Mailbox,
  Message,
  Notification,
  PlaybookVersion,
  ProviderKind,
  Reminder,
  Role,
  Send,
  SendState,
  Suggestion,
  User,
  ValidationIssue,
} from "../core/types";
import { SCHEMA } from "./schema";

type Row = Record<string, unknown>;

const id = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();
const str = (value: unknown) => (typeof value === "string" ? value : "");
const strOrNull = (value: unknown) => (typeof value === "string" ? value : null);
const json = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export type InboxView = "mine" | "unassigned" | "open" | "waiting" | "closed" | "all";

export type NewMessage = {
  conversationId: string;
  mailboxId: string;
  externalId: string;
  direction: "inbound" | "outbound";
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  text: string;
  sentAt: string;
  messageIdHeader: string;
  references: string[];
  sentByUserId?: string | null;
  attachments?: Array<{ filename: string; mimeType: string; content: Uint8Array }>;
};

function toUser(row: Row): User {
  return {
    id: str(row.id),
    email: str(row.email),
    name: str(row.name),
    role: str(row.role) as Role,
    signature: str(row.signature),
    createdAt: str(row.created_at),
  };
}

function toMailbox(row: Row): Mailbox {
  return {
    id: str(row.id),
    provider: str(row.provider) as ProviderKind,
    address: str(row.address),
    displayName: str(row.display_name),
    status: str(row.status) as Mailbox["status"],
    lastSyncAt: strOrNull(row.last_sync_at),
    lastError: strOrNull(row.last_error),
    createdAt: str(row.created_at),
  };
}

function toConversation(row: Row): Conversation {
  return {
    id: str(row.id),
    mailboxId: str(row.mailbox_id),
    subject: str(row.subject),
    customer: { name: str(row.customer_name), email: str(row.customer_email) },
    status: str(row.status) as ConversationStatus,
    assigneeId: strOrNull(row.assignee_id),
    category: str(row.category) as Category,
    lastMessageAt: str(row.last_message_at),
    lastInboundAt: strOrNull(row.last_inbound_at),
    snippet: str(row.snippet),
    unread: row.unread === 1,
  };
}

function toDraft(row: Row): Draft {
  return {
    id: str(row.id),
    conversationId: str(row.conversation_id),
    forMessageId: str(row.for_message_id),
    state: str(row.state) as DraftState,
    body: str(row.body),
    analysis: json<DraftAnalysis | null>(row.analysis_json, null),
    issues: json<ValidationIssue[]>(row.issues_json, []),
    error: strOrNull(row.error),
    model: strOrNull(row.model),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    sentBody: strOrNull(row.sent_body),
    editClass: strOrNull(row.edit_class) as EditClass | null,
    discardReason: strOrNull(row.discard_reason) as DiscardReason | null,
  };
}

function toSend(row: Row): Send {
  return {
    id: str(row.id),
    conversationId: str(row.conversation_id),
    draftId: strOrNull(row.draft_id),
    state: str(row.state) as SendState,
    body: str(row.body),
    error: strOrNull(row.error),
    userId: str(row.user_id),
    createdAt: str(row.created_at),
  };
}

export class Store {
  readonly db: Database;

  constructor(path = ":memory:") {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  // Users and sessions

  countUsers() {
    return (this.db.query("SELECT count(*) AS n FROM users").get() as { n: number }).n;
  }

  createUser(input: { email: string; name: string; role: Role; passwordHash: string }): User {
    const user = { id: id(), createdAt: nowIso() };
    this.db
      .query("INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(user.id, input.email.toLowerCase().trim(), input.name.trim(), input.role, input.passwordHash, user.createdAt);
    return this.user(user.id)!;
  }

  user(userId: string): User | null {
    const row = this.db.query("SELECT * FROM users WHERE id = ?").get(userId) as Row | null;
    return row ? toUser(row) : null;
  }

  userWithHash(email: string): { user: User; passwordHash: string } | null {
    const row = this.db.query("SELECT * FROM users WHERE email = ?").get(email.toLowerCase().trim()) as Row | null;
    return row ? { user: toUser(row), passwordHash: str(row.password_hash) } : null;
  }

  listUsers(): User[] {
    return (this.db.query("SELECT * FROM users ORDER BY created_at").all() as Row[]).map(toUser);
  }

  updateUser(userId: string, patch: { name?: string; role?: Role; signature?: string; passwordHash?: string }) {
    const current = this.db.query("SELECT * FROM users WHERE id = ?").get(userId) as Row | null;
    if (!current) return null;
    this.db
      .query("UPDATE users SET name = ?, role = ?, signature = ?, password_hash = ? WHERE id = ?")
      .run(
        patch.name ?? str(current.name),
        patch.role ?? str(current.role),
        patch.signature ?? str(current.signature),
        patch.passwordHash ?? str(current.password_hash),
        userId,
      );
    return this.user(userId);
  }

  deleteUser(userId: string) {
    this.db.query("DELETE FROM users WHERE id = ?").run(userId);
  }

  createSession(tokenHash: string, userId: string, expiresAt: string) {
    this.db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(tokenHash, userId, expiresAt);
  }

  sessionUser(tokenHash: string, at = nowIso()): User | null {
    const row = this.db
      .query("SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?")
      .get(tokenHash, at) as Row | null;
    return row ? toUser(row) : null;
  }

  deleteSession(tokenHash: string) {
    this.db.query("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  // Mailboxes

  createMailbox(input: { provider: ProviderKind; address: string; displayName: string; credentials: string }): Mailbox {
    const mailboxId = id();
    this.db
      .query(
        `INSERT INTO mailboxes (id, provider, address, display_name, credentials, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider, address) DO UPDATE SET credentials = excluded.credentials, display_name = excluded.display_name, status = 'active', last_error = NULL`,
      )
      .run(mailboxId, input.provider, input.address.toLowerCase(), input.displayName, input.credentials, nowIso());
    const row = this.db
      .query("SELECT * FROM mailboxes WHERE provider = ? AND address = ?")
      .get(input.provider, input.address.toLowerCase()) as Row;
    return toMailbox(row);
  }

  listMailboxes(): Mailbox[] {
    return (this.db.query("SELECT * FROM mailboxes ORDER BY created_at").all() as Row[]).map(toMailbox);
  }

  mailbox(mailboxId: string): Mailbox | null {
    const row = this.db.query("SELECT * FROM mailboxes WHERE id = ?").get(mailboxId) as Row | null;
    return row ? toMailbox(row) : null;
  }

  mailboxSecrets(mailboxId: string): { credentials: string; cursor: string | null } | null {
    const row = this.db.query("SELECT credentials, cursor FROM mailboxes WHERE id = ?").get(mailboxId) as Row | null;
    return row ? { credentials: str(row.credentials), cursor: strOrNull(row.cursor) } : null;
  }

  updateMailbox(
    mailboxId: string,
    patch: { cursor?: string; status?: Mailbox["status"]; lastSyncAt?: string; lastError?: string | null; credentials?: string },
  ) {
    const sets: string[] = [];
    const values: Array<string | null> = [];
    const set = (column: string, value: string | null | undefined) => {
      if (value === undefined) return;
      sets.push(`${column} = ?`);
      values.push(value);
    };
    set("cursor", patch.cursor);
    set("status", patch.status);
    set("last_sync_at", patch.lastSyncAt);
    set("last_error", patch.lastError);
    set("credentials", patch.credentials);
    if (!sets.length) return;
    this.db.query(`UPDATE mailboxes SET ${sets.join(", ")} WHERE id = ?`).run(...values, mailboxId);
  }

  deleteMailbox(mailboxId: string) {
    this.db.query("DELETE FROM mailboxes WHERE id = ?").run(mailboxId);
  }

  // Conversations and messages

  conversationByHint(mailboxId: string, hint: string): Conversation | null {
    const row = this.db
      .query("SELECT * FROM conversations WHERE mailbox_id = ? AND thread_hint = ? LIMIT 1")
      .get(mailboxId, hint) as Row | null;
    return row ? toConversation(row) : null;
  }

  conversationByHeaders(mailboxId: string, headers: string[]): Conversation | null {
    const wanted = headers.filter(Boolean);
    if (!wanted.length) return null;
    const row = this.db
      .query(
        `SELECT conversations.* FROM messages JOIN conversations ON conversations.id = messages.conversation_id
         WHERE messages.mailbox_id = ? AND messages.message_id_header IN (${wanted.map(() => "?").join(", ")})
         ORDER BY messages.sent_at DESC LIMIT 1`,
      )
      .get(mailboxId, ...wanted) as Row | null;
    return row ? toConversation(row) : null;
  }

  createConversation(input: { mailboxId: string; threadHint: string | null; subject: string; customer: Address; at: string }): Conversation {
    const conversationId = id();
    this.db
      .query(
        `INSERT INTO conversations (id, mailbox_id, thread_hint, subject, customer_name, customer_email, last_message_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(conversationId, input.mailboxId, input.threadHint, input.subject, input.customer.name, input.customer.email, input.at);
    return this.conversation(conversationId)!;
  }

  conversation(conversationId: string): Conversation | null {
    const row = this.db.query("SELECT * FROM conversations WHERE id = ?").get(conversationId) as Row | null;
    return row ? toConversation(row) : null;
  }

  listConversations(input: { view: InboxView; userId?: string; query?: string; limit?: number }): Conversation[] {
    const where: string[] = [];
    const values: string[] = [];
    switch (input.view) {
      case "mine":
        where.push("status != 'closed'", "assignee_id = ?");
        values.push(input.userId ?? "");
        break;
      case "unassigned":
        where.push("status != 'closed'", "assignee_id IS NULL");
        break;
      case "open":
      case "waiting":
      case "closed":
        where.push("status = ?");
        values.push(input.view);
        break;
      case "all":
        break;
      default: {
        const exhaustive: never = input.view;
        throw new Error(`Unknown view ${String(exhaustive)}`);
      }
    }
    const query = input.query?.trim();
    if (query) {
      where.push(
        "(subject LIKE ? OR customer_name LIKE ? OR customer_email LIKE ? OR id IN (SELECT conversation_id FROM messages WHERE text LIKE ?))",
      );
      const like = `%${query.replace(/[%_]/g, (char) => `\\${char}`)}%`;
      values.push(like, like, like, like);
    }
    const sql = `SELECT * FROM conversations ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY last_message_at DESC LIMIT ${Math.min(input.limit ?? 200, 500)}`;
    return (this.db.query(sql).all(...values) as Row[]).map(toConversation);
  }

  viewCounts(userId: string): Record<InboxView, number> {
    const row = this.db
      .query(
        `SELECT
          sum(status != 'closed' AND assignee_id = ?) AS mine,
          sum(status != 'closed' AND assignee_id IS NULL) AS unassigned,
          sum(status = 'open') AS open,
          sum(status = 'waiting') AS waiting,
          sum(status = 'closed') AS closed,
          count(*) AS "all"
         FROM conversations`,
      )
      .get(userId) as Record<InboxView, number | null>;
    return {
      mine: row.mine ?? 0,
      unassigned: row.unassigned ?? 0,
      open: row.open ?? 0,
      waiting: row.waiting ?? 0,
      closed: row.closed ?? 0,
      all: row.all ?? 0,
    };
  }

  updateConversation(
    conversationId: string,
    patch: { status?: ConversationStatus; assigneeId?: string | null; category?: Category; unread?: boolean },
  ) {
    const current = this.conversation(conversationId);
    if (!current) return null;
    this.db
      .query("UPDATE conversations SET status = ?, assignee_id = ?, category = ?, unread = ? WHERE id = ?")
      .run(
        patch.status ?? current.status,
        patch.assigneeId === undefined ? current.assigneeId : patch.assigneeId,
        patch.category ?? current.category,
        (patch.unread ?? current.unread) ? 1 : 0,
        conversationId,
      );
    return this.conversation(conversationId);
  }

  /** True when the provider id, or a non-empty Message-ID header, is already stored for the mailbox. */
  hasMessage(mailboxId: string, externalId: string, messageIdHeader = "") {
    return (
      this.db
        .query("SELECT 1 FROM messages WHERE mailbox_id = ? AND (external_id = ? OR (? != '' AND message_id_header = ?))")
        .get(mailboxId, externalId, messageIdHeader, messageIdHeader) !== null
    );
  }

  messageExternalId(messageId: string) {
    const row = this.db.query("SELECT external_id FROM messages WHERE id = ?").get(messageId) as Row | null;
    return str(row?.external_id);
  }

  /** Inserts a message once per provider id. Returns null when it was already stored. */
  insertMessage(input: NewMessage): Message | null {
    const messageId = id();
    const inserted = this.db
      .query(
        `INSERT INTO messages (id, conversation_id, mailbox_id, external_id, direction, from_name, from_email, to_json, cc_json,
           subject, text, sent_at, message_id_header, references_json, sent_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (mailbox_id, external_id) DO NOTHING`,
      )
      .run(
        messageId,
        input.conversationId,
        input.mailboxId,
        input.externalId,
        input.direction,
        input.from.name,
        input.from.email,
        JSON.stringify(input.to),
        JSON.stringify(input.cc),
        input.subject,
        input.text,
        input.sentAt,
        input.messageIdHeader,
        JSON.stringify(input.references),
        input.sentByUserId ?? null,
      );
    if (inserted.changes === 0) return null;
    for (const attachment of input.attachments ?? []) {
      this.db
        .query("INSERT INTO attachments (id, message_id, filename, mime_type, size, content) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id(), messageId, attachment.filename, attachment.mimeType, attachment.content.byteLength, attachment.content);
    }
    this.refreshConversation(input.conversationId, input.direction === "inbound");
    return this.message(messageId);
  }

  private refreshConversation(conversationId: string, inbound: boolean) {
    const latest = this.db
      .query("SELECT text, sent_at FROM messages WHERE conversation_id = ? ORDER BY sent_at DESC LIMIT 1")
      .get(conversationId) as Row | null;
    const lastInbound = this.db
      .query("SELECT max(sent_at) AS at FROM messages WHERE conversation_id = ? AND direction = 'inbound'")
      .get(conversationId) as Row;
    const snippet = str(latest?.text).replace(/\s+/g, " ").trim().slice(0, 160);
    this.db
      .query(
        `UPDATE conversations SET last_message_at = ?, last_inbound_at = ?, snippet = ?,
           unread = CASE WHEN ? THEN 1 ELSE unread END,
           status = CASE WHEN ? THEN 'open' ELSE status END
         WHERE id = ?`,
      )
      .run(str(latest?.sent_at), strOrNull(lastInbound.at), snippet, inbound ? 1 : 0, inbound ? 1 : 0, conversationId);
  }

  message(messageId: string): Message | null {
    const row = this.db.query("SELECT * FROM messages WHERE id = ?").get(messageId) as Row | null;
    return row ? this.toMessage(row) : null;
  }

  messages(conversationId: string): Message[] {
    return (this.db.query("SELECT * FROM messages WHERE conversation_id = ? ORDER BY sent_at").all(conversationId) as Row[]).map(
      (row) => this.toMessage(row),
    );
  }

  private toMessage(row: Row): Message {
    const attachments = (
      this.db.query("SELECT id, message_id, filename, mime_type, size FROM attachments WHERE message_id = ?").all(str(row.id)) as Row[]
    ).map(
      (attachment): Attachment => ({
        id: str(attachment.id),
        messageId: str(attachment.message_id),
        filename: str(attachment.filename),
        mimeType: str(attachment.mime_type),
        size: Number(attachment.size),
      }),
    );
    return {
      id: str(row.id),
      conversationId: str(row.conversation_id),
      direction: str(row.direction) as Message["direction"],
      from: { name: str(row.from_name), email: str(row.from_email) },
      to: json<Address[]>(row.to_json, []),
      cc: json<Address[]>(row.cc_json, []),
      subject: str(row.subject),
      text: str(row.text),
      sentAt: str(row.sent_at),
      messageIdHeader: str(row.message_id_header),
      attachments,
      sentByUserId: strOrNull(row.sent_by_user_id),
    };
  }

  messageReferences(messageId: string): string[] {
    const row = this.db.query("SELECT references_json FROM messages WHERE id = ?").get(messageId) as Row | null;
    return json<string[]>(row?.references_json, []);
  }

  conversationThreadHint(conversationId: string): string | null {
    const row = this.db.query("SELECT thread_hint FROM conversations WHERE id = ?").get(conversationId) as Row | null;
    return strOrNull(row?.thread_hint);
  }

  attachmentContent(attachmentId: string): { filename: string; mimeType: string; content: Uint8Array; conversationId: string } | null {
    const row = this.db
      .query(
        `SELECT attachments.filename, attachments.mime_type, attachments.content, messages.conversation_id
         FROM attachments JOIN messages ON messages.id = attachments.message_id WHERE attachments.id = ?`,
      )
      .get(attachmentId) as Row | null;
    if (!row) return null;
    return {
      filename: str(row.filename),
      mimeType: str(row.mime_type),
      content: row.content as Uint8Array,
      conversationId: str(row.conversation_id),
    };
  }

  // Drafts

  createDraft(input: { conversationId: string; forMessageId: string; instruction?: string }): Draft {
    const draftId = id();
    const at = nowIso();
    this.db
      .query(
        "INSERT INTO drafts (id, conversation_id, for_message_id, state, instruction, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)",
      )
      .run(draftId, input.conversationId, input.forMessageId, input.instruction ?? "", at, at);
    return this.draft(draftId)!;
  }

  draft(draftId: string): Draft | null {
    const row = this.db.query("SELECT * FROM drafts WHERE id = ?").get(draftId) as Row | null;
    return row ? toDraft(row) : null;
  }

  draftInstruction(draftId: string) {
    const row = this.db.query("SELECT instruction FROM drafts WHERE id = ?").get(draftId) as Row | null;
    return str(row?.instruction);
  }

  /** The newest draft that still matters for the conversation. */
  currentDraft(conversationId: string): Draft | null {
    const row = this.db
      .query("SELECT * FROM drafts WHERE conversation_id = ? AND state != 'discarded' ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(conversationId) as Row | null;
    return row ? toDraft(row) : null;
  }

  updateDraft(
    draftId: string,
    patch: {
      state?: DraftState;
      body?: string;
      analysis?: DraftAnalysis | null;
      issues?: ValidationIssue[];
      error?: string | null;
      model?: string | null;
      sentBody?: string;
      editClass?: EditClass;
      discardReason?: DiscardReason;
    },
  ) {
    const current = this.draft(draftId);
    if (!current) return null;
    this.db
      .query(
        `UPDATE drafts SET state = ?, body = ?, analysis_json = ?, issues_json = ?, error = ?, model = ?, sent_body = ?,
           edit_class = ?, discard_reason = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.state ?? current.state,
        patch.body ?? current.body,
        JSON.stringify(patch.analysis === undefined ? current.analysis : patch.analysis),
        JSON.stringify(patch.issues ?? current.issues),
        patch.error === undefined ? current.error : patch.error,
        patch.model === undefined ? current.model : patch.model,
        patch.sentBody ?? current.sentBody,
        patch.editClass ?? current.editClass,
        patch.discardReason ?? current.discardReason,
        nowIso(),
        draftId,
      );
    return this.draft(draftId);
  }

  /** Atomically moves the oldest queued draft to generating. */
  claimQueuedDraft(): Draft | null {
    const row = this.db
      .query(
        `UPDATE drafts SET state = 'generating', updated_at = ?
         WHERE id = (SELECT id FROM drafts WHERE state = 'queued' ORDER BY created_at, rowid LIMIT 1)
         RETURNING *`,
      )
      .get(nowIso()) as Row | null;
    return row ? toDraft(row) : null;
  }

  /** Drafts still open for older messages are replaced when a newer customer message lands. */
  supersedeDrafts(conversationId: string, keepForMessageId: string) {
    this.db
      .query(
        `UPDATE drafts SET state = 'discarded', discard_reason = 'superseded', updated_at = ?
         WHERE conversation_id = ? AND for_message_id != ? AND state IN ('queued','generating','ready','failed')`,
      )
      .run(nowIso(), conversationId, keepForMessageId);
  }

  requeueInterruptedDrafts() {
    this.db.query("UPDATE drafts SET state = 'queued', updated_at = ? WHERE state = 'generating'").run(nowIso());
  }

  // Sends

  /** Stages a send under an idempotency key. A repeated key returns the first send. */
  stageSend(input: { conversationId: string; draftId: string | null; key: string; body: string; userId: string }): { send: Send; fresh: boolean } {
    const sendId = id();
    const inserted = this.db
      .query(
        `INSERT INTO sends (id, conversation_id, draft_id, idempotency_key, state, body, user_id, created_at)
         VALUES (?, ?, ?, ?, 'staged', ?, ?, ?) ON CONFLICT (idempotency_key) DO NOTHING`,
      )
      .run(sendId, input.conversationId, input.draftId, input.key, input.body, input.userId, nowIso());
    const row = this.db.query("SELECT * FROM sends WHERE idempotency_key = ?").get(input.key) as Row;
    return { send: toSend(row), fresh: inserted.changes === 1 };
  }

  updateSend(sendId: string, state: SendState, error: string | null = null) {
    this.db.query("UPDATE sends SET state = ?, error = ? WHERE id = ?").run(state, error, sendId);
  }

  sends(conversationId: string): Send[] {
    return (this.db.query("SELECT * FROM sends WHERE conversation_id = ? ORDER BY created_at").all(conversationId) as Row[]).map(toSend);
  }

  send(sendId: string): Send | null {
    const row = this.db.query("SELECT * FROM sends WHERE id = ?").get(sendId) as Row | null;
    return row ? toSend(row) : null;
  }

  // Playbook

  playbook(): PlaybookVersion | null {
    const row = this.db.query("SELECT * FROM playbook_versions ORDER BY saved_at DESC, rowid DESC LIMIT 1").get() as Row | null;
    return row ? this.toPlaybook(row) : null;
  }

  playbookVersions(limit = 50): PlaybookVersion[] {
    return (this.db.query("SELECT * FROM playbook_versions ORDER BY saved_at DESC, rowid DESC LIMIT ?").all(limit) as Row[]).map((row) =>
      this.toPlaybook(row),
    );
  }

  playbookVersion(versionId: string): PlaybookVersion | null {
    const row = this.db.query("SELECT * FROM playbook_versions WHERE id = ?").get(versionId) as Row | null;
    return row ? this.toPlaybook(row) : null;
  }

  savePlaybook(content: string, note: string, savedBy: string | null): PlaybookVersion {
    const versionId = id();
    this.db
      .query("INSERT INTO playbook_versions (id, content, note, saved_by, saved_at) VALUES (?, ?, ?, ?, ?)")
      .run(versionId, content, note, savedBy, nowIso());
    return this.playbookVersion(versionId)!;
  }

  private toPlaybook(row: Row): PlaybookVersion {
    return { id: str(row.id), content: str(row.content), note: str(row.note), savedBy: strOrNull(row.saved_by), savedAt: str(row.saved_at) };
  }

  // Edit learning

  addLesson(input: Omit<Lesson, "id" | "createdAt">): Lesson {
    const lesson: Lesson = { ...input, id: id(), createdAt: nowIso() };
    this.db
      .query("INSERT INTO lessons (id, draft_id, category, summary, rule, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(lesson.id, lesson.draftId, lesson.category, lesson.summary, lesson.rule, lesson.createdAt);
    return lesson;
  }

  lessons(limit = 100): Lesson[] {
    return (this.db.query("SELECT * FROM lessons ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map((row) => ({
      id: str(row.id),
      draftId: str(row.draft_id),
      category: str(row.category),
      summary: str(row.summary),
      rule: str(row.rule),
      createdAt: str(row.created_at),
    }));
  }

  addSuggestion(input: { rule: string; rationale: string; lessonIds: string[] }): Suggestion {
    const suggestion: Suggestion = { ...input, id: id(), state: "pending", createdAt: nowIso() };
    this.db
      .query("INSERT INTO suggestions (id, rule, rationale, lesson_ids_json, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
      .run(suggestion.id, suggestion.rule, suggestion.rationale, JSON.stringify(suggestion.lessonIds), suggestion.createdAt);
    return suggestion;
  }

  suggestions(state?: Suggestion["state"]): Suggestion[] {
    const rows = (
      state
        ? this.db.query("SELECT * FROM suggestions WHERE state = ? ORDER BY created_at DESC").all(state)
        : this.db.query("SELECT * FROM suggestions ORDER BY created_at DESC").all()
    ) as Row[];
    return rows.map((row) => ({
      id: str(row.id),
      rule: str(row.rule),
      rationale: str(row.rationale),
      lessonIds: json<string[]>(row.lesson_ids_json, []),
      state: str(row.state) as Suggestion["state"],
      createdAt: str(row.created_at),
    }));
  }

  setSuggestionState(suggestionId: string, state: Suggestion["state"]) {
    this.db.query("UPDATE suggestions SET state = ? WHERE id = ?").run(state, suggestionId);
  }

  // Reminders and notifications

  addReminder(input: { conversationId: string; dueAt: string; note: string; createdBy: string | null }): Reminder {
    const reminder: Reminder = { ...input, id: id(), doneAt: null };
    this.db
      .query("INSERT INTO reminders (id, conversation_id, due_at, note, created_by) VALUES (?, ?, ?, ?, ?)")
      .run(reminder.id, reminder.conversationId, reminder.dueAt, reminder.note, reminder.createdBy);
    return reminder;
  }

  reminders(conversationId: string): Reminder[] {
    return (this.db.query("SELECT * FROM reminders WHERE conversation_id = ? ORDER BY due_at").all(conversationId) as Row[]).map(
      (row) => ({
        id: str(row.id),
        conversationId: str(row.conversation_id),
        dueAt: str(row.due_at),
        note: str(row.note),
        doneAt: strOrNull(row.done_at),
        createdBy: strOrNull(row.created_by),
      }),
    );
  }

  /** Marks due reminders done and returns them, so each fires once. */
  takeDueReminders(at = nowIso()): Reminder[] {
    const rows = this.db
      .query("UPDATE reminders SET done_at = ? WHERE done_at IS NULL AND due_at <= ? RETURNING *")
      .all(at, at) as Row[];
    return rows.map((row) => ({
      id: str(row.id),
      conversationId: str(row.conversation_id),
      dueAt: str(row.due_at),
      note: str(row.note),
      doneAt: strOrNull(row.done_at),
      createdBy: strOrNull(row.created_by),
    }));
  }

  notify(input: { userId: string; kind: Notification["kind"]; conversationId: string | null; text: string }) {
    this.db
      .query("INSERT INTO notifications (id, user_id, kind, conversation_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id(), input.userId, input.kind, input.conversationId, input.text, nowIso());
  }

  notifications(userId: string, limit = 50): Notification[] {
    return (
      this.db.query("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, limit) as Row[]
    ).map((row) => ({
      id: str(row.id),
      userId: str(row.user_id),
      kind: str(row.kind) as Notification["kind"],
      conversationId: strOrNull(row.conversation_id),
      text: str(row.text),
      readAt: strOrNull(row.read_at),
      createdAt: str(row.created_at),
    }));
  }

  markNotificationsRead(userId: string) {
    this.db.query("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(nowIso(), userId);
  }

  // Settings

  setting(key: string): string | null {
    const row = this.db.query("SELECT value FROM settings WHERE key = ?").get(key) as Row | null;
    return strOrNull(row?.value);
  }

  setSetting(key: string, value: string) {
    this.db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}
