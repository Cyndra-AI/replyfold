import { describe, expect, test } from "bun:test";
import { OAuthFlow, TokenSource } from "../../src/mail/oauth";

type Call = { url: string; init?: RequestInit };

function fakeFetch(responses: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(responses).find((prefix) => url.startsWith(prefix));
    if (!key) return new Response("not found", { status: 404 });
    return Response.json(responses[key]);
  };
  return { calls, fetcher };
}

const clients = {
  gmail: { clientId: "google-id", clientSecret: "google-secret" },
  microsoft: { clientId: "ms-id", clientSecret: "ms-secret", tenant: "common" },
};

describe("OAuthFlow", () => {
  test("builds a PKCE authorization URL with the provider scopes", () => {
    const flow = new OAuthFlow(clients, "http://localhost:3000/");
    const { url, state } = flow.start("microsoft", "user-1");
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/oauth/microsoft/callback");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("scope")).toContain("Mail.Send");
    expect(parsed.searchParams.get("state")).toBe(state);
  });

  test("exchanges the code and reads the mailbox address", async () => {
    const { calls, fetcher } = fakeFetch({
      "https://oauth2.googleapis.com/token": { access_token: "at", refresh_token: "rt", expires_in: 3600 },
      "https://gmail.googleapis.com/gmail/v1/users/me/profile": { emailAddress: "Help@Shop.test" },
    });
    const flow = new OAuthFlow(clients, "http://localhost:3000", fetcher);
    const { state } = flow.start("gmail", "user-1", 0);
    const result = await flow.complete("gmail", { state, code: "the-code", userId: "user-1" }, 1000);
    expect(result.identity.email).toBe("help@shop.test");
    expect(result.tokens).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: 3_601_000 });
    const body = new URLSearchParams(String(calls[0]?.init?.body));
    expect(body.get("code_verifier")?.length).toBeGreaterThan(40);
  });

  test("refuses a state from another user or a second use", async () => {
    const { fetcher } = fakeFetch({});
    const flow = new OAuthFlow(clients, "http://localhost:3000", fetcher);
    const { state } = flow.start("gmail", "user-1");
    await expect(flow.complete("gmail", { state, code: "c", userId: "user-2" })).rejects.toThrow("expired");
    await expect(flow.complete("gmail", { state, code: "c", userId: "user-1" })).rejects.toThrow("expired");
  });

  test("explains a missing client configuration", () => {
    const flow = new OAuthFlow({}, "http://localhost:3000");
    expect(flow.configured("gmail")).toBe(false);
    expect(() => flow.start("gmail", "u")).toThrow("Add its client ID and secret");
  });
});

describe("TokenSource", () => {
  test("refreshes once for concurrent callers and persists the new tokens", async () => {
    let refreshes = 0;
    const saved: string[] = [];
    const source = new TokenSource(
      { accessToken: "old", refreshToken: "rt", expiresAt: 0 },
      async () => {
        refreshes += 1;
        return { accessToken: "new", refreshToken: "rt2", expiresAt: Date.now() + 3_600_000 };
      },
      (tokens) => saved.push(tokens.refreshToken),
    );
    const tokens = await Promise.all([source.accessToken(), source.accessToken()]);
    expect(tokens).toEqual(["new", "new"]);
    expect(refreshes).toBe(1);
    expect(saved).toEqual(["rt2"]);
  });
});
