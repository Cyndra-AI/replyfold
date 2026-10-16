import { z } from "zod";
import { ChatGPTSignInError, CHATGPT, loopbackRedirect } from "../ai/chatgpt";
import { ModelError } from "../ai/model";
import { KEY_PROVIDERS, type AiProviderKind, type KeyProviderKind } from "../ai/providers";
import { CATEGORIES, CONVERSATION_STATUSES, DISCARD_REASONS, MOODS, ROLES, type Mood, type Role, type User } from "../core/types";
import { randomToken, sha256 } from "../core/secrets";
import type { InboxView } from "../db/store";
import { DEMO_PASSWORD, DEMO_TEAM } from "../demo/fixtures";
import { acceptSuggestion } from "../drafts/learning";
import { assistPrompt, buildPacket, SYSTEM } from "../drafts/prompts";
import { ASSIST_TASKS, AssistSchema } from "../drafts/schemas";
import { composeNew, sendReply } from "../drafts/send";
import { ImapSettingsSchema, verifyImapSettings } from "../mail/imap";
import { OAuthError, type OAuthProviderKind } from "../mail/oauth";
import { IMAP_PRESETS } from "../mail/presets";
import type { Runtime } from "../runtime";
import { computeStats } from "../stats";
import { body, HttpError, json, RateLimiter, readCookie } from "./http";
import { handleMcp } from "./mcp";

const SESSION_COOKIE = "rf_session";
const SESSION_DAYS = 14;
const RANK: Record<Role, number> = { agent: 0, lead: 1, owner: 2 };

type Context = { request: Request; url: URL; params: Record<string, string>; user: User | null };
type Handler = (context: Context & { user: User }) => Promise<Response> | Response;
type PublicHandler = (context: Context) => Promise<Response> | Response;
type Route = { method: string; pattern: URLPattern; role: Role | null; handler: Handler | PublicHandler };

const address = z.object({ name: z.string().default(""), email: z.string().trim().toLowerCase().email() });
const password = z.string().min(10, "Use at least 10 characters.").max(200);

export type AppOptions = { verifyImap?: typeof verifyImapSettings };

export function createApp(runtime: Runtime, options: AppOptions = {}) {
  const { store, config } = runtime;
  const loginLimiter = new RateLimiter(10, 15 * 60_000);
  const verifyImap = options.verifyImap ?? verifyImapSettings;
  const routes: Route[] = [];
  function route(method: string, path: string, role: Role, handler: Handler): void;
  function route(method: string, path: string, role: null, handler: PublicHandler): void;
  function route(method: string, path: string, role: Role | null, handler: Handler | PublicHandler) {
    routes.push({ method, pattern: new URLPattern({ pathname: path }), role, handler });
  }

  const secure = config.publicUrl.startsWith("https://");
  const sessionCookie = (token: string, maxAge: number) =>
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

  function startSession(user: User) {
    const token = randomToken();
    store.createSession(sha256(token), user.id, new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString());
    return json({ user }, { headers: { "set-cookie": sessionCookie(token, SESSION_DAYS * 86_400) } });
  }

  function conversationOr404(id: string) {
    const conversation = store.conversation(id);
    if (!conversation) throw new HttpError(404, "This conversation does not exist.");
    return conversation;
  }

  route("GET", "/api/session", null, ({ user }) =>
    json({
      user,
      setupRequired: store.countUsers() === 0,
      demo: config.demo ? { email: DEMO_TEAM[0]!.email, password: DEMO_PASSWORD } : null,
    }),
  );

  route("POST", "/api/setup", null, async ({ request }) => {
    const input = await body(request, z.object({ name: z.string().trim().min(1).max(120), email: z.string().trim().email(), password }));
    if (store.countUsers() > 0) throw new HttpError(409, "This workspace already has an owner. Sign in instead.");
    const user = store.createUser({ ...input, role: "owner", passwordHash: await Bun.password.hash(input.password) });
    return startSession(user);
  });

  route("POST", "/api/login", null, async ({ request }) => {
    const input = await body(request, z.object({ email: z.string().trim(), password: z.string() }));
    if (!loginLimiter.allow(input.email.toLowerCase())) throw new HttpError(429, "Too many attempts. Wait 15 minutes and try again.");
    const found = store.userWithHash(input.email);
    const ok = found ? await Bun.password.verify(input.password, found.passwordHash) : false;
    if (!found || !ok) throw new HttpError(401, "The email or password is wrong.");
    return startSession(found.user);
  });

  route("POST", "/api/logout", null, ({ request }) => {
    const token = readCookie(request, SESSION_COOKIE);
    if (token) store.deleteSession(sha256(token));
    return json({ ok: true }, { headers: { "set-cookie": sessionCookie("", 0) } });
  });

  route("PUT", "/api/me", "agent", async ({ request, user }) => {
    const input = await body(
      request,
      z.object({ name: z.string().trim().min(1).max(120).optional(), signature: z.string().max(2000).optional(), password: password.optional() }),
    );
    const updated = store.updateUser(user.id, {
      name: input.name,
      signature: input.signature,
      passwordHash: input.password ? await Bun.password.hash(input.password) : undefined,
    });
    return json({ user: updated });
  });

  const VIEWS = ["mine", "unassigned", "open", "waiting", "closed", "all"] as const;

  route("GET", "/api/inbox", "agent", ({ url, user }) => {
    const view = (VIEWS as readonly string[]).includes(url.searchParams.get("view") ?? "") ? (url.searchParams.get("view") as InboxView) : "open";
    const moodParam = url.searchParams.get("mood") ?? "";
    const mood = (MOODS as readonly string[]).includes(moodParam) ? (moodParam as Mood) : undefined;
    const conversations = store.listConversations({ view, userId: user.id, query: url.searchParams.get("q") ?? "", mood }).map((conversation) => {
      const draft = store.currentDraft(conversation.id);
      return {
        ...conversation,
        draft: draft ? { state: draft.state, issues: draft.issues.length, needsHuman: draft.analysis?.needsHuman ?? false } : null,
      };
    });
    return json({ conversations, counts: store.viewCounts(user.id) });
  });

  route("GET", "/api/conversations/:id", "agent", ({ params }) => {
    const conversation = conversationOr404(params.id!);
    return json({
      conversation,
      mailbox: store.mailbox(conversation.mailboxId),
      messages: store.messages(conversation.id),
      draft: store.currentDraft(conversation.id),
      sends: store.sends(conversation.id),
      reminders: store.reminders(conversation.id),
    });
  });

  route("PATCH", "/api/conversations/:id", "agent", async ({ request, params, user }) => {
    const before = conversationOr404(params.id!);
    const input = await body(
      request,
      z.object({
        status: z.enum(CONVERSATION_STATUSES).optional(),
        assigneeId: z.string().nullable().optional(),
        category: z.enum(CATEGORIES).optional(),
        unread: z.boolean().optional(),
      }),
    );
    if (input.assigneeId && !store.user(input.assigneeId)) throw new HttpError(400, "That teammate does not exist.");
    const conversation = store.updateConversation(before.id, input);
    if (input.assigneeId && input.assigneeId !== before.assigneeId && input.assigneeId !== user.id) {
      store.notify({ userId: input.assigneeId, kind: "assigned", conversationId: before.id, text: `${user.name} assigned you "${before.subject}".` });
      runtime.emit({ type: "notifications" });
    }
    runtime.emit({ type: "inbox" });
    return json({ conversation });
  });

  route("POST", "/api/conversations/:id/draft", "agent", async ({ request, params }) => {
    const conversation = conversationOr404(params.id!);
    const input = await body(request, z.object({ instruction: z.string().max(2000).default("") }));
    const latest = store.messages(conversation.id).at(-1);
    if (!latest) throw new HttpError(400, "This conversation has no messages.");
    if (latest.direction !== "inbound") throw new HttpError(409, "The customer has not written since the last reply.");
    const current = store.currentDraft(conversation.id);
    if (current && (current.state === "queued" || current.state === "generating")) throw new HttpError(409, "A draft is already being written.");
    if (current && current.state !== "sent") store.updateDraft(current.id, { state: "discarded", discardReason: "superseded" });
    const draft = store.createDraft({ conversationId: conversation.id, forMessageId: latest.id, instruction: input.instruction });
    void runtime.drainDrafts();
    runtime.emit({ type: "conversation", conversationId: conversation.id });
    return json({ draft });
  });

  route("POST", "/api/conversations/:id/discard", "agent", async ({ request, params }) => {
    const conversation = conversationOr404(params.id!);
    const input = await body(request, z.object({ reason: z.enum(DISCARD_REASONS) }));
    const draft = store.currentDraft(conversation.id);
    if (!draft || draft.state === "sent") throw new HttpError(409, "There is no draft to discard.");
    store.updateDraft(draft.id, { state: "discarded", discardReason: input.reason });
    runtime.emit({ type: "conversation", conversationId: conversation.id });
    return json({ ok: true });
  });

  route("POST", "/api/conversations/:id/send", "agent", async ({ request, params, user }) => {
    const conversation = conversationOr404(params.id!);
    const input = await body(
      request,
      z.object({ body: z.string().trim().min(1, "Write a reply first.").max(50_000), draftId: z.string().nullable(), key: z.string().min(8).max(100) }),
    );
    if (input.draftId && store.draft(input.draftId)?.conversationId !== conversation.id) throw new HttpError(400, "This draft belongs to another conversation.");
    const outcome = await sendReply({ store, providerFor: runtime.providerFor, user, conversationId: conversation.id, ...input });
    if (outcome.state === "sent" && input.draftId) runtime.learn(input.draftId);
    runtime.emit({ type: "conversation", conversationId: conversation.id });
    runtime.emit({ type: "inbox" });
    return json(outcome, { status: outcome.state === "failed" ? 502 : 200 });
  });

  route("POST", "/api/sends/:id/resolve", "agent", async ({ request, params }) => {
    const send = store.send(params.id!);
    if (!send || send.state !== "uncertain") throw new HttpError(409, "Only a send with an unknown outcome can be resolved.");
    const input = await body(request, z.object({ outcome: z.enum(["sent", "failed"]) }));
    store.updateSend(send.id, input.outcome, input.outcome === "failed" ? "Marked as not sent." : null);
    if (input.outcome === "sent") store.updateConversation(send.conversationId, { status: "waiting" });
    runtime.emit({ type: "conversation", conversationId: send.conversationId });
    return json({ ok: true });
  });

  route("POST", "/api/conversations/:id/reminders", "agent", async ({ request, params, user }) => {
    const conversation = conversationOr404(params.id!);
    const input = await body(request, z.object({ dueAt: z.string().datetime({ offset: true }), note: z.string().trim().min(1).max(500) }));
    const reminder = store.addReminder({ conversationId: conversation.id, dueAt: new Date(input.dueAt).toISOString(), note: input.note, createdBy: user.id });
    store.updateConversation(conversation.id, { status: "waiting" });
    runtime.emit({ type: "inbox" });
    return json({ reminder });
  });

  route("POST", "/api/assist", "agent", async ({ request }) => {
    const input = await body(request, z.object({ conversationId: z.string(), task: z.enum(ASSIST_TASKS), text: z.string().max(20_000).default("") }));
    const conversation = conversationOr404(input.conversationId);
    const packet = buildPacket({
      customer: conversation.customer,
      subject: conversation.subject,
      messages: store.messages(conversation.id),
      playbook: store.playbook()?.content ?? "",
      instruction: "",
      currentTime: new Date().toISOString(),
    });
    const result = await runtime.model.json({ task: "assist", system: SYSTEM, prompt: assistPrompt({ task: input.task, text: input.text, packet }), schema: AssistSchema });
    return json(result);
  });

  route("POST", "/api/compose", "agent", async ({ request, user }) => {
    const input = await body(
      request,
      z.object({
        mailboxId: z.string(),
        to: z.array(address).min(1, "Add at least one recipient."),
        cc: z.array(address).default([]),
        subject: z.string().trim().min(1, "Add a subject.").max(300),
        body: z.string().trim().min(1, "Write a message first.").max(50_000),
        key: z.string().min(8).max(100),
      }),
    );
    const outcome = await composeNew({ store, providerFor: runtime.providerFor, user, ...input });
    runtime.emit({ type: "inbox" });
    return json(outcome, { status: outcome.state === "failed" ? 502 : 200 });
  });

  route("GET", "/api/attachments/:id", "agent", ({ params }) => {
    const attachment = store.attachmentContent(params.id!);
    if (!attachment) throw new HttpError(404, "This attachment does not exist.");
    const inline = /^image\/(png|jpe?g|gif|webp)$/.test(attachment.mimeType);
    return new Response(new Blob([new Uint8Array(attachment.content)]), {
      headers: {
        "content-type": inline ? attachment.mimeType : "application/octet-stream",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${attachment.filename.replace(/["\r\n]/g, "_")}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
      },
    });
  });

  route("GET", "/api/playbook", "agent", () =>
    json({ current: store.playbook(), versions: store.playbookVersions(), suggestions: store.suggestions("pending"), lessons: store.lessons(20) }),
  );

  route("PUT", "/api/playbook", "lead", async ({ request, user }) => {
    const input = await body(request, z.object({ content: z.string().max(100_000), note: z.string().max(200).default("") }));
    return json({ current: store.savePlaybook(input.content, input.note, user.id) });
  });

  route("POST", "/api/playbook/versions/:id/restore", "lead", ({ params, user }) => {
    const version = store.playbookVersion(params.id!);
    if (!version) throw new HttpError(404, "This version does not exist.");
    return json({ current: store.savePlaybook(version.content, `Restored the version from ${version.savedAt.slice(0, 10)}`, user.id) });
  });

  route("POST", "/api/suggestions/:id/accept", "lead", ({ params, user }) => {
    try {
      return json({ current: acceptSuggestion({ store, suggestionId: params.id!, userId: user.id }) });
    } catch (error) {
      throw new HttpError(409, error instanceof Error ? error.message : "Could not accept the suggestion.");
    }
  });

  route("POST", "/api/suggestions/:id/reject", "lead", ({ params }) => {
    store.setSuggestionState(params.id!, "rejected");
    return json({ ok: true });
  });

  route("GET", "/api/stats", "agent", ({ url }) => {
    const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 14) || 14, 1), 90);
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86_400_000);
    from.setUTCHours(0, 0, 0, 0);
    return json(computeStats(store, { from: from.toISOString(), to: to.toISOString() }));
  });

  route("GET", "/api/team", "agent", () => json({ users: store.listUsers() }));

  route("POST", "/api/team", "owner", async ({ request }) => {
    const input = await body(request, z.object({ name: z.string().trim().min(1).max(120), email: z.string().trim().email(), role: z.enum(ROLES), password }));
    if (store.userWithHash(input.email)) throw new HttpError(409, "Someone with this email is already on the team.");
    const user = store.createUser({ ...input, passwordHash: await Bun.password.hash(input.password) });
    return json({ user });
  });

  route("PATCH", "/api/team/:id", "owner", async ({ request, params, user }) => {
    const input = await body(request, z.object({ role: z.enum(ROLES) }));
    if (params.id === user.id && input.role !== "owner") throw new HttpError(400, "You cannot remove your own owner role.");
    const updated = store.updateUser(params.id!, { role: input.role });
    if (!updated) throw new HttpError(404, "This teammate does not exist.");
    return json({ user: updated });
  });

  route("DELETE", "/api/team/:id", "owner", ({ params, user }) => {
    if (params.id === user.id) throw new HttpError(400, "You cannot remove yourself.");
    store.deleteUser(params.id!);
    return json({ ok: true });
  });

  route("GET", "/api/mailboxes", "agent", () =>
    json({
      mailboxes: store.listMailboxes(),
      oauth: { gmail: runtime.oauth.configured("gmail"), microsoft: runtime.oauth.configured("microsoft") },
      redirectUris: { gmail: runtime.oauth.redirectUri("gmail"), microsoft: runtime.oauth.redirectUri("microsoft") },
      presets: IMAP_PRESETS,
    }),
  );

  route("POST", "/api/mailboxes/imap", "lead", async ({ request }) => {
    const input = await body(
      request,
      ImapSettingsSchema.extend({ address: z.string().trim().toLowerCase().email(), displayName: z.string().trim().min(1).max(120) }),
    );
    const { address: mailAddress, displayName, ...settings } = input;
    try {
      await verifyImap(settings);
    } catch (error) {
      throw new HttpError(400, `Could not sign in to the mail server: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    const mailbox = store.createMailbox({ provider: "imap", address: mailAddress, displayName, credentials: runtime.box.seal(settings) });
    runtime.forget(mailbox.id);
    void runtime.sync(mailbox.id);
    return json({ mailbox });
  });

  const OAUTH_KINDS = ["gmail", "microsoft"] as const;

  route("GET", "/api/oauth/:provider/start", "lead", ({ params, user }) => {
    const provider = params.provider as OAuthProviderKind;
    if (!(OAUTH_KINDS as readonly string[]).includes(provider)) throw new HttpError(404, "Unknown provider.");
    try {
      return Response.redirect(runtime.oauth.start(provider, user.id).url, 302);
    } catch (error) {
      if (error instanceof OAuthError) return Response.redirect(`/settings/mailboxes?error=${encodeURIComponent(error.message)}`, 302);
      throw error;
    }
  });

  route("GET", "/api/oauth/:provider/callback", "lead", async ({ params, url, user }) => {
    const provider = params.provider as OAuthProviderKind;
    const back = (message: string, ok = false) => Response.redirect(`/settings/mailboxes?${ok ? "connected" : "error"}=${encodeURIComponent(message)}`, 302);
    if (!(OAUTH_KINDS as readonly string[]).includes(provider)) return back("Unknown provider.");
    if (url.searchParams.get("error")) return back("The connection was cancelled.");
    try {
      const result = await runtime.oauth.complete(provider, { state: url.searchParams.get("state") ?? "", code: url.searchParams.get("code") ?? "", userId: user.id });
      const mailbox = store.createMailbox({
        provider,
        address: result.identity.email,
        displayName: result.identity.name || result.identity.email,
        credentials: runtime.box.seal(result.tokens),
      });
      runtime.forget(mailbox.id);
      void runtime.sync(mailbox.id);
      return back(mailbox.address, true);
    } catch (error) {
      return back(error instanceof OAuthError ? error.message : "The connection failed. Try again.");
    }
  });

  const KEY_KINDS = KEY_PROVIDERS as readonly string[];
  const keyKind = (value: string | undefined) => {
    if (!value || !KEY_KINDS.includes(value)) throw new HttpError(404, "Unknown AI provider.");
    return value as KeyProviderKind;
  };
  const modelErrors = async <T>(work: () => Promise<T> | T) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ModelError || error instanceof ChatGPTSignInError) throw new HttpError(400, error.message);
      throw error;
    }
  };

  async function aiView(url: URL) {
    const { plan } = await runtime.ai.classifier(runtime.ai.active() ? null : runtime.envModel);
    const loopback = loopbackRedirect(url);
    return {
      providers: runtime.ai.providers(),
      active: runtime.ai.active(),
      env: runtime.envModel ? { name: runtime.envModel.name, kind: config.model.kind } : null,
      chatgpt: {
        ...runtime.ai.chatgptView(),
        canStartHere: Boolean(loopback),
        loopbackUrl: `http://127.0.0.1:${config.port}/settings/ai`,
      },
      classification: { ...runtime.ai.classifySettings(), openrouterConnected: runtime.ai.connected("openrouter"), plan },
    };
  }

  route("GET", "/api/ai", "agent", async ({ url }) => json(await aiView(url)));

  route("PUT", "/api/ai/providers/:kind", "owner", async ({ request, params, url }) => {
    const kind = keyKind(params.kind);
    const input = await body(request, z.object({ apiKey: z.string().max(500).optional(), baseUrl: z.string().max(500).optional() }));
    if (input.baseUrl && !/^https?:\/\/[^\s]+$/.test(input.baseUrl.trim())) throw new HttpError(400, "The base URL must start with http:// or https://.");
    await modelErrors(() => runtime.ai.saveKey(kind, input));
    return json(await aiView(url));
  });

  route("DELETE", "/api/ai/providers/:kind", "owner", async ({ params, url }) => {
    runtime.ai.removeKey(keyKind(params.kind));
    return json(await aiView(url));
  });

  route("POST", "/api/ai/providers/:kind/test", "owner", async ({ request, params }) => {
    const kind = keyKind(params.kind);
    const input = await body(request, z.object({ apiKey: z.string().max(500).optional(), baseUrl: z.string().max(500).optional() }));
    const result = await modelErrors(() => runtime.ai.test(kind, input));
    return json({ ok: result.ok, message: result.message, models: result.models.length });
  });

  route("GET", "/api/ai/models/:kind", "owner", async ({ params, url }) => {
    const kind = params.kind === "chatgpt" ? "chatgpt" : keyKind(params.kind);
    const models = await modelErrors(() => runtime.ai.models(kind, url.searchParams.get("fresh") === "1"));
    return json({ models });
  });

  route("PUT", "/api/ai/active", "owner", async ({ request, url }) => {
    const input = await body(request, z.object({ kind: z.enum([...KEY_PROVIDERS, "chatgpt"]), model: z.string().trim().min(1).max(200) }));
    await modelErrors(() => runtime.ai.setActive(input as { kind: AiProviderKind; model: string }));
    return json(await aiView(url));
  });

  route("DELETE", "/api/ai/active", "owner", async ({ url }) => {
    runtime.ai.clearActive();
    return json(await aiView(url));
  });

  route("PUT", "/api/ai/classification", "owner", async ({ request, url }) => {
    const input = await body(request, z.object({ jev: z.boolean().optional(), model: z.string().trim().min(1).max(200).nullable().optional() }));
    await modelErrors(() => runtime.ai.saveClassifySettings(input));
    return json(await aiView(url));
  });

  route("POST", "/api/ai/classification/test", "owner", async ({ request }) => {
    const input = await body(request, z.object({ subject: z.string().max(300).default(""), text: z.string().max(6000).default("") }));
    const { classifier, plan } = await runtime.ai.classifier(runtime.ai.active() ? null : runtime.envModel);
    if (!classifier) throw new HttpError(409, plan.note);
    const sample = input.text.trim()
      ? input
      : { subject: "Order #1042 still not here", text: "I ordered a mug set two weeks ago and tracking has not moved in six days. It is a birthday present for Saturday. This is the second time I am writing. Can someone please tell me what is going on?" };
    const started = Date.now();
    const result = await modelErrors(() => classifier.classify(sample));
    return json({ ...result, model: classifier.name, ms: Date.now() - started, sample });
  });

  route("GET", "/api/ai/chatgpt/start", "owner", ({ url, user }) => {
    const back = (message: string) => Response.redirect(`/settings/ai?error=${encodeURIComponent(message)}`, 302);
    const redirectUri = loopbackRedirect(url);
    if (!redirectUri) return back(`ChatGPT sign-in only finishes on the computer that runs Replyfold. Open http://127.0.0.1:${config.port}/settings/ai there and try again.`);
    const { url: authorize } = runtime.ai.chatgpt.start({
      userId: user.id,
      redirectUri,
      consent: url.searchParams.get("consent") === "1",
      newAccount: url.searchParams.get("account") === "new",
    });
    return Response.redirect(authorize, 302);
  });

  route("GET", CHATGPT.callbackPath, "owner", async ({ url, user }) => {
    try {
      const result = await runtime.ai.chatgpt.complete({ userId: user.id, params: url.searchParams });
      return Response.redirect(`/settings/ai?chatgpt=${result.planEnabled ? "connected" : "no-plan"}`, 302);
    } catch (error) {
      const message = error instanceof ChatGPTSignInError ? error.message : "The ChatGPT sign-in failed. Try again.";
      return Response.redirect(`/settings/ai?error=${encodeURIComponent(message)}`, 302);
    }
  });

  route("POST", "/api/ai/chatgpt/signout", "owner", async ({ url }) => {
    const { revoked } = await runtime.ai.chatgpt.signOut();
    if (runtime.ai.active()?.kind === "chatgpt") runtime.ai.clearActive();
    return json({ revoked, ...(await aiView(url)) });
  });

  route("POST", "/api/ai/chatgpt/welcomed", "owner", () => {
    runtime.ai.markWelcomed();
    return json({ ok: true });
  });

  route("POST", "/api/mailboxes/:id/sync", "agent", async ({ params }) => {
    if (!store.mailbox(params.id!)) throw new HttpError(404, "This mailbox does not exist.");
    return json({ result: await runtime.sync(params.id!) });
  });

  route("PATCH", "/api/mailboxes/:id", "lead", async ({ request, params }) => {
    const input = await body(request, z.object({ status: z.enum(["active", "paused"]) }));
    if (!store.mailbox(params.id!)) throw new HttpError(404, "This mailbox does not exist.");
    store.updateMailbox(params.id!, { status: input.status });
    return json({ mailbox: store.mailbox(params.id!) });
  });

  route("DELETE", "/api/mailboxes/:id", "owner", ({ params }) => {
    store.deleteMailbox(params.id!);
    runtime.forget(params.id!);
    runtime.emit({ type: "inbox" });
    return json({ ok: true });
  });

  route("GET", "/api/notifications", "agent", ({ user }) => json({ notifications: store.notifications(user.id) }));

  route("POST", "/api/notifications/read", "agent", ({ user }) => {
    store.markNotificationsRead(user.id);
    return json({ ok: true });
  });

  route("GET", "/api/events", "agent", ({ request }) => {
    const encoder = new TextEncoder();
    let unsubscribe = () => false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream({
      start(controller) {
        const send = (data: string) => controller.enqueue(encoder.encode(data));
        send(": connected\n\n");
        unsubscribe = runtime.subscribe((event) => send(`data: ${JSON.stringify(event)}\n\n`));
        heartbeat = setInterval(() => send(": ping\n\n"), 25_000);
        request.signal.addEventListener("abort", () => {
          unsubscribe();
          clearInterval(heartbeat);
          try {
            controller.close();
          } catch {
            // The stream may already be closed by cancel().
          }
        });
      },
      cancel() {
        unsubscribe();
        clearInterval(heartbeat);
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
  });

  function sameOrigin(request: Request) {
    const origin = request.headers.get("origin");
    if (!origin) return true;
    return origin === new URL(request.url).origin || origin === config.publicUrl;
  }

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return handleMcp(request, runtime);
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (mutating && !sameOrigin(request)) return json({ error: "Cross-site request refused." }, { status: 403 });
    const token = readCookie(request, SESSION_COOKIE);
    const user = token ? store.sessionUser(sha256(token)) : null;
    let pathMatched = false;
    for (const candidate of routes) {
      const match = candidate.pattern.exec(url);
      if (!match) continue;
      pathMatched = true;
      if (candidate.method !== request.method) continue;
      const params = Object.fromEntries(Object.entries(match.pathname.groups).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      try {
        if (candidate.role) {
          if (!user) throw new HttpError(401, "Sign in to continue.");
          if (RANK[user.role] < RANK[candidate.role]) throw new HttpError(403, "Your role cannot do this. Ask an owner.");
          return await (candidate.handler as Handler)({ request, url, params, user });
        }
        return await (candidate.handler as PublicHandler)({ request, url, params, user });
      } catch (error) {
        if (error instanceof HttpError) return json({ error: error.message }, { status: error.status });
        console.error(JSON.stringify({ level: "error", route: `${request.method} ${url.pathname}`, message: error instanceof Error ? error.message : String(error) }));
        return json({ error: error instanceof Error ? error.message : "Something went wrong." }, { status: 500 });
      }
    }
    return json({ error: pathMatched ? "Method not allowed." : "Not found." }, { status: pathMatched ? 405 : 404 });
  };
}
