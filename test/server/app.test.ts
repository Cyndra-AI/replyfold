import { beforeEach, describe, expect, test } from "bun:test";
import { readConfig } from "../../src/config";
import { Store } from "../../src/db/store";
import { seedDemo } from "../../src/demo/seed";
import { DemoModel } from "../../src/demo/model";
import { Runtime } from "../../src/runtime";
import { createApp } from "../../src/server/app";

const BASE = "http://localhost:3000";
const TEST_KEY = "x".repeat(32);

function harness(env: Record<string, string> = {}) {
  const store = new Store();
  const config = readConfig({ REPLYFOLD_SECRET_KEY: TEST_KEY, MODEL_PROVIDER: "demo", MCP_TOKEN: TEST_KEY, ...env });
  const runtime = new Runtime(store, config, new DemoModel());
  const verified: unknown[] = [];
  const app = createApp(runtime, { verifyImap: async (settings) => void verified.push(settings) });
  let cookie = "";
  const call = async (method: string, path: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const response = await app(
      new Request(`${BASE}${path}`, {
        method,
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      }),
    );
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0]!;
    const type = response.headers.get("content-type") ?? "";
    return { status: response.status, data: type.includes("json") ? ((await response.json()) as any) : null, response };
  };
  return { store, runtime, call, verified, signOut: () => (cookie = "") };
}

describe("first run", () => {
  test("the first person creates the owner account, and setup closes after that", async () => {
    const { call, signOut } = harness();
    expect((await call("GET", "/api/session")).data).toMatchObject({ user: null, setupRequired: true });
    const created = await call("POST", "/api/setup", { name: "Morgan", email: "morgan@shop.test", password: "correct horse battery" });
    expect(created.data.user.role).toBe("owner");
    expect((await call("GET", "/api/session")).data.user.email).toBe("morgan@shop.test");
    signOut();
    expect((await call("POST", "/api/setup", { name: "X", email: "x@shop.test", password: "another long password" })).status).toBe(409);
  });

  test("rejects a short password", async () => {
    const { call } = harness();
    expect((await call("POST", "/api/setup", { name: "M", email: "m@shop.test", password: "short" })).status).toBe(400);
  });
});

describe("with the demo workspace", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness();
    await seedDemo(h.store);
  });

  const login = (email: string) => h.call("POST", "/api/login", { email, password: "fernhill-demo" });

  test("requires a session for the inbox", async () => {
    expect((await h.call("GET", "/api/inbox")).status).toBe(401);
  });

  test("a wrong password is refused", async () => {
    expect((await h.call("POST", "/api/login", { email: "morgan@fernhill.example", password: "nope" })).status).toBe(401);
  });

  test("an agent reads the inbox, opens a conversation and sends the draft", async () => {
    await login("jonas@fernhill.example");
    const inbox = await h.call("GET", "/api/inbox?view=open");
    expect(inbox.data.conversations).toHaveLength(10);
    expect(inbox.data.counts.open).toBe(10);
    const target = inbox.data.conversations.find((item: { subject: string }) => item.subject.includes("cracked"));
    const detail = await h.call("GET", `/api/conversations/${target.id}`);
    expect(detail.data.draft.state).toBe("ready");
    expect(detail.data.draft.body).toStartWith("Hello Sam,");

    const sent = await h.call("POST", `/api/conversations/${target.id}/send`, { body: detail.data.draft.body, draftId: detail.data.draft.id, key: "send-key-0001" });
    expect(sent.data.state).toBe("sent");
    const after = await h.call("GET", `/api/conversations/${target.id}`);
    expect(after.data.conversation.status).toBe("waiting");
    expect(after.data.messages.at(-1).direction).toBe("outbound");
  });

  test("search finds conversations by message text", async () => {
    await login("jonas@fernhill.example");
    const result = await h.call("GET", "/api/inbox?view=all&q=stoneware");
    expect(result.data.conversations.map((item: { subject: string }) => item.subject)).toEqual(["Wholesale question"]);
  });

  test("an agent cannot edit the playbook or manage the team", async () => {
    await login("jonas@fernhill.example");
    expect((await h.call("PUT", "/api/playbook", { content: "x" })).status).toBe(403);
    expect((await h.call("POST", "/api/team", { name: "N", email: "n@x.test", role: "agent", password: "long enough pw" })).status).toBe(403);
  });

  test("a lead accepts a learned suggestion into the playbook", async () => {
    await login("priya@fernhill.example");
    const before = await h.call("GET", "/api/playbook");
    const [suggestion] = before.data.suggestions;
    const accepted = await h.call("POST", `/api/suggestions/${suggestion.id}/accept`);
    expect(accepted.data.current.content).toContain(suggestion.rule);
  });

  test("a lead connects an IMAP mailbox after the server login check", async () => {
    await login("priya@fernhill.example");
    const result = await h.call("POST", "/api/mailboxes/imap", {
      address: "Support@Example.org",
      displayName: "Example Support",
      username: "support@example.org",
      password: "app-password",
      imap: { host: "imap.example.org", port: 993, secure: true },
      smtp: { host: "smtp.example.org", port: 465, secure: true },
    });
    expect(result.data.mailbox).toMatchObject({ provider: "imap", address: "support@example.org" });
    expect(h.verified).toHaveLength(1);
    const listed = await h.call("GET", "/api/mailboxes");
    expect(JSON.stringify(listed.data)).not.toContain("app-password");
  });

  test("refuses a cross-site write", async () => {
    await login("jonas@fernhill.example");
    const result = await h.call("POST", "/api/logout", {}, { origin: "https://evil.example" });
    expect(result.status).toBe(403);
  });

  test("the owner sees statistics", async () => {
    await login("morgan@fernhill.example");
    const stats = await h.call("GET", "/api/stats?days=14");
    expect(stats.data.sent).toBeGreaterThanOrEqual(30);
    expect(stats.data.daily).toHaveLength(14);
  });
});

describe("MCP endpoint", () => {
  test("needs the token and lists read-only tools", async () => {
    const h = harness();
    await seedDemo(h.store);
    expect((await h.call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    const auth = { authorization: `Bearer ${TEST_KEY}` };
    const tools = await h.call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, auth);
    expect(tools.data.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["list_conversations", "get_conversation", "get_statistics", "get_playbook"]);
    const listed = await h.call("POST", "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_conversations", arguments: { limit: 3 } } }, auth);
    expect(JSON.parse(listed.data.result.content[0].text)).toHaveLength(3);
  });
});
