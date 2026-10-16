import { z } from "zod";
import { CodexModel, OpenAICompatibleModel, type ModelProvider } from "./ai/model";
import type { Config } from "./config";
import { SecretBox } from "./core/secrets";
import type { Store } from "./db/store";
import { DemoModel } from "./demo/model";
import { DemoProvider } from "./demo/provider";
import { learnFromEdit } from "./drafts/learning";
import { generateDraft } from "./drafts/workflow";
import { GmailProvider } from "./mail/gmail";
import { ImapProvider, ImapSettingsSchema, imapflowSession, smtpSender } from "./mail/imap";
import { MicrosoftProvider } from "./mail/microsoft";
import { OAuthFlow, TokenSource, type OAuthProviderKind, type OAuthTokens } from "./mail/oauth";
import type { MailProvider } from "./mail/provider";
import { syncMailbox } from "./mail/sync";

const OAuthCredentials = z.object({ accessToken: z.string(), refreshToken: z.string(), expiresAt: z.number() });

export type AppEvent = { type: "inbox" | "conversation" | "mailboxes" | "notifications"; conversationId?: string };

export function createModel(config: Config): ModelProvider {
  switch (config.model.kind) {
    case "codex":
      return new CodexModel({ model: config.model.model, binary: config.model.binary });
    case "openai":
      return new OpenAICompatibleModel(config.model);
    case "demo":
      return new DemoModel();
    default: {
      const exhaustive: never = config.model;
      throw new Error(`Unknown model provider ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Owns everything that runs in the background: mailbox sync, the draft worker, reminders and live events. */
export class Runtime {
  readonly box: SecretBox;
  readonly oauth: OAuthFlow;
  private readonly providers = new Map<string, MailProvider>();
  private readonly listeners = new Set<(event: AppEvent) => void>();
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private draining = false;
  private syncing = new Set<string>();

  constructor(
    readonly store: Store,
    readonly config: Config,
    readonly model: ModelProvider = createModel(config),
  ) {
    this.box = new SecretBox(config.secretKey);
    this.oauth = new OAuthFlow(config.oauth, config.publicUrl);
  }

  subscribe(listener: (event: AppEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AppEvent) {
    for (const listener of this.listeners) listener(event);
  }

  forget(mailboxId: string) {
    this.providers.delete(mailboxId);
  }

  providerFor = (mailboxId: string): MailProvider => {
    const cached = this.providers.get(mailboxId);
    if (cached) return cached;
    const mailbox = this.store.mailbox(mailboxId);
    const secrets = this.store.mailboxSecrets(mailboxId);
    if (!mailbox || !secrets) throw new Error("This mailbox is not connected.");
    let provider: MailProvider;
    switch (mailbox.provider) {
      case "demo":
        provider = new DemoProvider();
        break;
      case "imap": {
        const settings = ImapSettingsSchema.parse(this.box.open(secrets.credentials));
        provider = new ImapProvider(mailbox.address, imapflowSession(settings), smtpSender(settings));
        break;
      }
      case "gmail":
      case "microsoft": {
        const kind: OAuthProviderKind = mailbox.provider;
        const tokens = new TokenSource(
          OAuthCredentials.parse(this.box.open(secrets.credentials)),
          (refreshToken) => this.oauth.refresh(kind, refreshToken),
          (next: OAuthTokens) => this.store.updateMailbox(mailboxId, { credentials: this.box.seal(next) }),
        );
        const accessToken = () => tokens.accessToken();
        provider = kind === "gmail" ? new GmailProvider(mailbox.address, accessToken) : new MicrosoftProvider(mailbox.address, accessToken);
        break;
      }
      default: {
        const exhaustive: never = mailbox.provider;
        throw new Error(`Unknown provider ${String(exhaustive)}`);
      }
    }
    this.providers.set(mailboxId, provider);
    return provider;
  };

  async sync(mailboxId: string) {
    if (this.syncing.has(mailboxId)) return null;
    const mailbox = this.store.mailbox(mailboxId);
    if (!mailbox) return null;
    this.syncing.add(mailboxId);
    try {
      const result = await syncMailbox({ store: this.store, mailbox, provider: this.providerFor(mailboxId) });
      this.emit({ type: "mailboxes" });
      if (result.ok && result.added) this.emit({ type: "inbox" });
      if (result.ok && result.draftsQueued) void this.drainDrafts();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateMailbox(mailboxId, { status: "error", lastError: message });
      this.emit({ type: "mailboxes" });
      return { ok: false as const, error: message };
    } finally {
      this.syncing.delete(mailboxId);
    }
  }

  async syncAll() {
    for (const mailbox of this.store.listMailboxes()) if (mailbox.status !== "paused") await this.sync(mailbox.id);
  }

  /** Works through queued drafts one at a time. A second call while draining is a no-op. */
  async drainDrafts() {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let draft = this.store.claimQueuedDraft(); draft; draft = this.store.claimQueuedDraft()) {
        this.emit({ type: "conversation", conversationId: draft.conversationId });
        const result = await generateDraft({ store: this.store, model: this.model, draftId: draft.id });
        if (result.state === "failed") {
          const assignee = this.store.conversation(result.conversationId)?.assigneeId;
          if (assignee) this.store.notify({ userId: assignee, kind: "draft_failed", conversationId: result.conversationId, text: "A draft could not be written." });
        }
        this.emit({ type: "conversation", conversationId: draft.conversationId });
        this.emit({ type: "inbox" });
      }
    } finally {
      this.draining = false;
    }
  }

  learn(draftId: string) {
    void learnFromEdit({ store: this.store, model: this.model, draftId }).catch(() => undefined);
  }

  fireReminders() {
    for (const reminder of this.store.takeDueReminders()) {
      const conversation = this.store.updateConversation(reminder.conversationId, { status: "open", unread: true });
      const target = reminder.createdBy ?? conversation?.assigneeId;
      if (target) this.store.notify({ userId: target, kind: "reminder_due", conversationId: reminder.conversationId, text: `Reminder: ${reminder.note}` });
      this.emit({ type: "inbox" });
      this.emit({ type: "notifications" });
    }
  }

  start() {
    this.store.requeueInterruptedDrafts();
    void this.syncAll();
    void this.drainDrafts();
    this.timers.push(setInterval(() => void this.syncAll(), this.config.syncIntervalMs));
    this.timers.push(setInterval(() => this.fireReminders(), 30_000));
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}
