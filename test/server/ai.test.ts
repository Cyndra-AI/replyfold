import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readConfig } from "../../src/config";
import { Store } from "../../src/db/store";
import { Runtime } from "../../src/runtime";
import { createApp } from "../../src/server/app";

const BASE = "http://127.0.0.1:3000";
const SECRET = "x".repeat(32);
const KEY = `openai-${"fake".repeat(4)}cdef`;
const OPENROUTER_KEY = `router-${"fake".repeat(4)}9c21`;

type Mode = { classify: "ok" | "fail"; rejectKey?: boolean };

/** Stands in for OpenAI and OpenRouter. A wrong key gets a 401 that echoes it back, like real APIs do. */
function fakeApis(mode: Mode) {
  const chatCalls: any[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (mode.rejectKey && auth.includes(KEY)) return Response.json({ error: { message: `Incorrect API key provided: ${KEY}` } }, { status: 401 });
    if (url === "https://api.openai.com/v1/models") return Response.json({ data: [{ id: "gpt-6-sol" }, { id: "gpt-6-luna" }, { id: "text-embedding-3-small" }] });
    if (url === "https://api.openai.com/v1/chat/completions") {
      const body = JSON.parse(String(init?.body));
      chatCalls.push(body);
      const task = body.response_format.json_schema.name;
      if (task === "classify") {
        return mode.classify === "ok"
          ? Response.json({ choices: [{ message: { content: '{"category":"shipping","mood":"angry"}' } }] })
          : Response.json({ error: { message: `Server error for ${KEY}` } }, { status: 500 });
      }
      if (task === "analyze") {
        const analysis = { summary: "Late parcel.", intent: "Find the parcel", category: "other", disposition: "reply", needsHuman: false, missingInformation: [], facts: [], confidence: 0.8 };
        return Response.json({ choices: [{ message: { content: JSON.stringify(analysis) } }] });
      }
      return Response.json({ choices: [{ message: { content: '{"body":"Hello Sam,\\n\\nWe are sorry. The parcel ships today.","citations":[]}' } }] });
    }
    return new Response("not mocked", { status: 404 });
  };
  return { chatCalls, fetcher };
}

function harness(mode: Mode = { classify: "ok" }) {
  const store = new Store();
  const config = readConfig({ REPLYFOLD_SECRET_KEY: SECRET, PORT: "3000" });
  const apis = fakeApis(mode);
  const runtime = new Runtime(store, config, { fetch: apis.fetcher });
  const app = createApp(runtime);
  let cookie = "";
  const call = async (method: string, path: string, payload?: unknown, base = BASE) => {
    const response = await app(
      new Request(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        redirect: "manual",
      }),
    );
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0]!;
    const text = await response.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { status: response.status, text, data, location: response.headers.get("location") };
  };
  return { store, runtime, call, apis };
}

function customerEmail(h: ReturnType<typeof harness>, text: string) {
  const mailbox = h.store.listMailboxes()[0] ?? h.store.createMailbox({ provider: "demo", address: "help@shop.example", displayName: "Shop", credentials: "{}" });
  const conversation = h.store.createConversation({ mailboxId: mailbox.id, threadHint: crypto.randomUUID(), subject: "Where is my parcel", customer: { name: "Sam", email: "sam@example.com" }, at: new Date().toISOString() });
  const message = h.store.insertMessage({
    conversationId: conversation.id,
    mailboxId: mailbox.id,
    externalId: crypto.randomUUID(),
    direction: "inbound",
    from: { name: "Sam", email: "sam@example.com" },
    to: [],
    cc: [],
    subject: "Where is my parcel",
    text,
    sentAt: new Date().toISOString(),
    messageIdHeader: `<${crypto.randomUUID()}@example.com>`,
    references: [],
  })!;
  h.store.createDraft({ conversationId: conversation.id, forMessageId: message.id });
  return { conversation, message };
}

let logged: string[] = [];
const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info };

beforeEach(() => {
  logged = [];
  for (const name of ["log", "error", "warn", "info"] as const) console[name] = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
});

afterEach(() => {
  Object.assign(console, originals);
});

async function owner(h: ReturnType<typeof harness>) {
  expect((await h.call("POST", "/api/setup", { name: "Morgan", email: "morgan@shop.example", password: "correct horse battery" })).status).toBe(200);
}

describe("API keys", () => {
  test("a saved key is encrypted at rest, masked in replies and never logged", async () => {
    const h = harness();
    await owner(h);
    const saved = await h.call("PUT", "/api/ai/providers/openai", { apiKey: KEY });
    expect(saved.status).toBe(200);
    const openai = saved.data.providers.find((provider: { kind: string }) => provider.kind === "openai");
    expect(openai).toMatchObject({ connected: true, keyHint: "••••cdef" });

    const tested = await h.call("POST", "/api/ai/providers/openai/test", {});
    expect(tested.data).toMatchObject({ ok: true, models: 2 });
    const models = await h.call("GET", "/api/ai/models/openai");
    expect(models.data.models.map((model: { id: string }) => model.id)).toEqual(["gpt-6-luna", "gpt-6-sol"]);
    await h.call("PUT", "/api/ai/active", { kind: "openai", model: "gpt-6-sol" });
    customerEmail(h, "This is the third time I write. Where is my parcel?");
    await h.runtime.drainDrafts();

    for (const path of ["/api/ai", "/api/mailboxes", "/api/inbox?view=all"]) expect((await h.call("GET", path)).text).not.toContain(KEY);
    const rows = h.store.db.query("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
    expect(rows.some((row) => row.key === "ai.key.openai")).toBe(true);
    for (const row of rows) expect(row.value).not.toContain(KEY.slice(0, 12));
    for (const line of logged) expect(line).not.toContain(KEY);
  });

  test("a refused key fails the connection test without echoing the key", async () => {
    const h = harness({ classify: "ok", rejectKey: true });
    await owner(h);
    await h.call("PUT", "/api/ai/providers/openai", { apiKey: KEY });
    const tested = await h.call("POST", "/api/ai/providers/openai/test", { apiKey: KEY });
    expect(tested.data.ok).toBe(false);
    expect(tested.data.message).toContain("401");
    expect(tested.text).not.toContain(KEY);
    const view = await h.call("GET", "/api/ai");
    expect(view.data.providers.find((provider: { kind: string }) => provider.kind === "openai").test.ok).toBe(false);
    expect(view.text).not.toContain(KEY);
    await h.call("PUT", "/api/ai/active", { kind: "openai", model: "gpt-6-sol" });
    const { conversation } = customerEmail(h, "Where is my parcel?");
    await h.runtime.drainDrafts();
    const draft = h.store.currentDraft(conversation.id)!;
    expect(draft.state).toBe("failed");
    expect(draft.error).not.toContain(KEY);
    expect((await h.call("GET", `/api/conversations/${conversation.id}`)).text).not.toContain(KEY);
    for (const line of logged) expect(line).not.toContain(KEY);
  });

  test("only an owner can change keys, and the base URL must be http or https", async () => {
    const h = harness();
    await owner(h);
    expect((await h.call("PUT", "/api/ai/providers/custom", { baseUrl: "file:///etc/passwd" })).status).toBe(400);
    await h.call("POST", "/api/team", { name: "Jo", email: "jo@shop.example", role: "lead", password: "another long password" });
    await h.call("POST", "/api/logout", {});
    await h.call("POST", "/api/login", { email: "jo@shop.example", password: "another long password" });
    expect((await h.call("PUT", "/api/ai/providers/openai", { apiKey: KEY })).status).toBe(403);
    expect((await h.call("GET", "/api/ai")).status).toBe(200);
  });
});

describe("the draft pipeline", () => {
  test("uses the selected model, the small model for classification, and stores the mood", async () => {
    const h = harness();
    await owner(h);
    await h.call("PUT", "/api/ai/providers/openai", { apiKey: KEY });
    await h.call("PUT", "/api/ai/active", { kind: "openai", model: "gpt-6-sol" });
    const { conversation, message } = customerEmail(h, "This is the third time I write. Where is my parcel?");
    await h.runtime.drainDrafts();

    const byTask = Object.fromEntries(h.apis.chatCalls.map((body) => [body.response_format.json_schema.name, body.model]));
    expect(byTask).toEqual({ classify: "gpt-6-luna", analyze: "gpt-6-sol", draft: "gpt-6-sol" });
    const draftCall = h.apis.chatCalls.find((body) => body.response_format.json_schema.name === "draft");
    expect(draftCall.messages[1].content).toContain("The customer is angry.");

    const detail = await h.call("GET", `/api/conversations/${conversation.id}`);
    expect(detail.data.conversation).toMatchObject({ mood: "angry", category: "shipping" });
    expect(detail.data.messages.find((item: { id: string }) => item.id === message.id).mood).toBe("angry");
    expect(detail.data.draft.state).toBe("ready");
    expect(detail.data.draft.model).toBe("gpt-6-sol");
  });

  test("the inbox filters by mood", async () => {
    const h = harness();
    await owner(h);
    await h.call("PUT", "/api/ai/providers/openai", { apiKey: KEY });
    await h.call("PUT", "/api/ai/active", { kind: "openai", model: "gpt-6-sol" });
    customerEmail(h, "Where is my parcel?");
    await h.runtime.drainDrafts();
    const calm = h.store.createConversation({ mailboxId: h.store.listMailboxes()[0]!.id, threadHint: "calm", subject: "Hello", customer: { name: "A", email: "a@example.com" }, at: new Date().toISOString() });
    h.store.updateConversation(calm.id, { mood: "calm" });

    const angry = await h.call("GET", "/api/inbox?view=all&mood=angry");
    expect(angry.data.conversations.map((row: { subject: string }) => row.subject)).toEqual(["Where is my parcel"]);
    expect((await h.call("GET", "/api/inbox?view=all&mood=calm")).data.conversations.map((row: { subject: string }) => row.subject)).toEqual(["Hello"]);
    expect((await h.call("GET", "/api/inbox?view=all&mood=happy")).data.conversations).toEqual([]);
    expect((await h.call("GET", "/api/inbox?view=all&mood=nonsense")).data.conversations).toHaveLength(2);
  });

  test("a failed classification never blocks the draft", async () => {
    const h = harness({ classify: "fail" });
    await owner(h);
    await h.call("PUT", "/api/ai/providers/openai", { apiKey: KEY });
    await h.call("PUT", "/api/ai/active", { kind: "openai", model: "gpt-6-sol" });
    const { conversation } = customerEmail(h, "Where is my parcel?");
    await h.runtime.drainDrafts();
    const detail = await h.call("GET", `/api/conversations/${conversation.id}`);
    expect(detail.data.draft.state).toBe("ready");
    expect(detail.data.conversation.mood).toBeNull();
    expect(detail.data.conversation.category).toBe("other");
  });

  test("with no provider at all, drafts fail with a clear reason and nothing is tagged", async () => {
    const h = harness();
    await owner(h);
    const { conversation } = customerEmail(h, "Where is my parcel?");
    await h.runtime.drainDrafts();
    const draft = h.store.currentDraft(conversation.id)!;
    expect(draft.state).toBe("failed");
    expect(draft.error).toContain("No AI model is set up");
    expect(h.store.conversation(conversation.id)!.mood).toBeNull();
    expect((await h.call("GET", "/api/ai")).data.classification.plan.kind).toBe("none");
  });
});

describe("classification settings", () => {
  test("the Jev toggle needs an OpenRouter key, and the test button runs one sample email", async () => {
    const h = harness();
    await owner(h);
    const refused = await h.call("PUT", "/api/ai/classification", { jev: true });
    expect(refused.status).toBe(400);
    expect(refused.data.error).toContain("Add an OpenRouter key");
    expect((await h.call("POST", "/api/ai/classification/test", {})).status).toBe(409);

    await h.call("PUT", "/api/ai/providers/openai", { apiKey: KEY });
    await h.call("PUT", "/api/ai/active", { kind: "openai", model: "gpt-6-sol" });
    const result = await h.call("POST", "/api/ai/classification/test", {});
    expect(result.data).toMatchObject({ category: "shipping", mood: "angry", model: "gpt-6-luna" });
    await h.call("PUT", "/api/ai/providers/openrouter", { apiKey: OPENROUTER_KEY });
    expect((await h.call("GET", "/api/ai")).text).not.toContain(OPENROUTER_KEY);
  });
});

describe("ChatGPT sign-in routes", () => {
  test("start refuses an address that is not 127.0.0.1 and explains where to go", async () => {
    const h = harness();
    await owner(h);
    const remote = await h.call("GET", "/api/ai/chatgpt/start", undefined, "https://support.example.com");
    expect(remote.status).toBe(302);
    expect(decodeURIComponent(remote.location ?? "")).toContain("http://127.0.0.1:3000/settings/ai");
    const local = await h.call("GET", "/api/ai/chatgpt/start");
    expect(local.location).toStartWith("https://auth.openai.com/api/accounts/authorize?");
    expect(new URL(local.location!).searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3000/auth/callback");
  });

  test("a callback with an unknown state goes back to settings with a message", async () => {
    const h = harness();
    await owner(h);
    const back = await h.call("GET", "/auth/callback?code=x&state=forged&client_id=oaiapp_x");
    expect(back.status).toBe(302);
    expect(back.location).toStartWith("/settings/ai?error=");
  });
});

describe("demo mode", () => {
  test("made-up keys work end to end against the built-in stand-in, with Jev tagging the mood", async () => {
    const { demoFetch } = await import("../../src/demo/apis");
    const store = new Store();
    const runtime = new Runtime(store, readConfig({ REPLYFOLD_SECRET_KEY: SECRET, REPLYFOLD_DEMO: "1" }), { fetch: demoFetch });
    runtime.ai.saveKey("anthropic", { apiKey: "sk-ant-demo-000000" });
    runtime.ai.saveKey("openrouter", { apiKey: "sk-or-demo-000000" });
    expect((await runtime.ai.test("anthropic")).ok).toBe(true);
    runtime.ai.setActive({ kind: "anthropic", model: "claude-opus-5-5" });
    runtime.ai.saveClassifySettings({ jev: true });
    const h = { store } as ReturnType<typeof harness>;
    const { conversation } = customerEmail(h, "I see two charges on my card. I am worried.");
    await runtime.drainDrafts();
    expect(store.currentDraft(conversation.id)).toMatchObject({ state: "ready", model: "claude-opus-5-5" });
    expect(store.conversation(conversation.id)).toMatchObject({ mood: "worried", category: "billing" });
  });
});
