export const SCHEMA_VERSION = 1;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','lead','agent')),
  password_hash TEXT NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mailboxes (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  address TEXT NOT NULL,
  display_name TEXT NOT NULL,
  credentials TEXT NOT NULL,
  cursor TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_sync_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (provider, address)
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  thread_hint TEXT,
  subject TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  category TEXT NOT NULL DEFAULT 'other',
  last_message_at TEXT NOT NULL,
  last_inbound_at TEXT,
  snippet TEXT NOT NULL DEFAULT '',
  unread INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS conversations_by_time ON conversations (status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS conversations_by_hint ON conversations (mailbox_id, thread_hint);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  mailbox_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  from_name TEXT NOT NULL,
  from_email TEXT NOT NULL,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL,
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  message_id_header TEXT NOT NULL,
  references_json TEXT NOT NULL,
  sent_by_user_id TEXT,
  UNIQUE (mailbox_id, external_id)
);
CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation_id, sent_at);
CREATE INDEX IF NOT EXISTS messages_by_header ON messages (mailbox_id, message_id_header);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  content BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  for_message_id TEXT NOT NULL,
  state TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  analysis_json TEXT,
  issues_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  model TEXT,
  instruction TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_body TEXT,
  edit_class TEXT,
  discard_reason TEXT
);
CREATE INDEX IF NOT EXISTS drafts_by_conversation ON drafts (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS drafts_by_state ON drafts (state, created_at);
CREATE TABLE IF NOT EXISTS sends (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  draft_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  body TEXT NOT NULL,
  error TEXT,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS playbook_versions (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  saved_by TEXT,
  saved_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  category TEXT NOT NULL,
  summary TEXT NOT NULL,
  rule TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY,
  rule TEXT NOT NULL,
  rationale TEXT NOT NULL,
  lesson_ids_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  due_at TEXT NOT NULL,
  note TEXT NOT NULL,
  done_at TEXT,
  created_by TEXT
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  conversation_id TEXT,
  text TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
