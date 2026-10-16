import { beforeAll, describe, expect, test } from "bun:test";
import { ChatGPTAuth, CHATGPT, loopbackRedirect, type ChatGPTAccount, type ChatGPTSession, type ChatGPTStorage } from "../../src/ai/chatgpt";

const REDIRECT = "http://127.0.0.1:3000/auth/callback";
const HOST = "urn:uuid:00000000-0000-4000-8000-000000000001";
const ISSUED = "oaiapp_issued_client";
let keyPair: CryptoKeyPair;
let publicJwk: Record<string, unknown>;

beforeAll(async () => {
  keyPair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  publicJwk = { ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), kid: "k1" };
});

async function idToken(claims: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = `${encode({ alg: "RS256", kid: "k1" })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(head));
  return `${head}.${Buffer.from(signature).toString("base64url")}`;
}

function memory(): ChatGPTStorage & { data: { session: ChatGPTSession | null; account: ChatGPTAccount | null } } {
  const data = { session: null as ChatGPTSession | null, account: null as ChatGPTAccount | null };
  return {
    data,
    hostId: () => HOST,
    session: () => data.session,
    saveSession: (session) => void (data.session = session),
    account: () => data.account,
    saveAccount: (account) => void (data.account = account),
  };
}

type Form = Record<string, string>;

function openai(options: { scope?: string; subject?: string; nonce?: (form: Form) => string } = {}) {
  const forms: Array<{ url: string; form: Form }> = [];
  let lastNonce = "";
  const fetcher = async (url: string, init?: RequestInit) => {
    if (url === CHATGPT.discovery) {
      return Response.json({ issuer: CHATGPT.issuer, jwks_uri: "https://auth.openai.com/.well-known/jwks.json", revocation_endpoint: "https://auth.openai.com/oauth/revoke" });
    }
    if (url.endsWith("jwks.json")) return Response.json({ keys: [publicJwk] });
    const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
    forms.push({ url, form });
    if (url === CHATGPT.token) {
      const now = Math.floor(Date.now() / 1000);
      return Response.json({
        access_token: `access-${forms.length}`,
        refresh_token: `refresh-${forms.length}`,
        id_token: await idToken({ iss: CHATGPT.issuer, aud: form.client_id, sub: options.subject ?? "user-1", email: "owner@example.com", exp: now + 3600, nonce: lastNonce }),
        token_type: "Bearer",
        expires_in: 3600,
        scope: options.scope ?? "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke",
      });
    }
    return new Response("", { status: 200 });
  };
  return { forms, fetcher, setNonce: (nonce: string) => (lastNonce = nonce) };
}

function startParams(url: string) {
  return Object.fromEntries(new URL(url).searchParams);
}

async function signIn(auth: ChatGPTAuth, server: ReturnType<typeof openai>, options: { newAccount?: boolean } = {}) {
  const { url } = auth.start({ userId: "u1", redirectUri: REDIRECT, ...options });
  const params = startParams(url);
  server.setNonce(params.nonce!);
  const callback = new URLSearchParams({ code: "code-1", state: params.state!, ...(params.client_id === CHATGPT.dynamicClient ? { client_id: ISSUED } : {}) });
  return { params, result: await auth.complete({ userId: "u1", params: callback }) };
}

describe("ChatGPT sign-in", () => {
  test("only a 127.0.0.1 address can receive the callback", () => {
    expect(loopbackRedirect(new URL("http://127.0.0.1:3000/api/ai/chatgpt/start"))).toBe(REDIRECT);
    expect(loopbackRedirect(new URL("http://localhost:3000/api/ai/chatgpt/start"))).toBeNull();
    expect(loopbackRedirect(new URL("https://support.example.com/api/ai/chatgpt/start"))).toBeNull();
  });

  test("the first sign-in registers through the dynamic client with every documented parameter", () => {
    const auth = new ChatGPTAuth(memory(), openai().fetcher);
    const { url } = auth.start({ userId: "u1", redirectUri: REDIRECT });
    expect(url.startsWith(`${CHATGPT.authorize}?`)).toBe(true);
    const params = startParams(url);
    expect(params).toMatchObject({
      client_id: "dynamic_agent_client",
      agent_name_hint: "Replyfold",
      ext_agent_host_id: HOST,
      response_type: "code",
      redirect_uri: REDIRECT,
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource: "https://api.openai.com/v1",
      code_challenge_method: "S256",
    });
    expect(params.state).toBeTruthy();
    expect(params.nonce).toBeTruthy();
    expect(params.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.prompt).toBeUndefined();
  });

  test("the callback exchanges the code with PKCE, checks the ID token and stores the session", async () => {
    const storage = memory();
    const server = openai();
    const auth = new ChatGPTAuth(storage, server.fetcher);
    const { result } = await signIn(auth, server);
    expect(result).toEqual({ email: "owner@example.com", planEnabled: true });
    const exchange = server.forms.find((entry) => entry.url === CHATGPT.token)!.form;
    expect(exchange).toMatchObject({ grant_type: "authorization_code", client_id: ISSUED, code: "code-1", redirect_uri: REDIRECT, resource: "https://api.openai.com/v1" });
    expect(exchange.code_verifier!.length).toBeGreaterThan(40);
    expect(exchange.client_secret).toBeUndefined();
    expect(storage.data.session).toMatchObject({ clientId: ISSUED, subject: "user-1", hostId: HOST, accessToken: "access-1", refreshToken: "refresh-1" });
    expect(storage.data.account).toEqual({ clientId: ISSUED, subject: "user-1", email: "owner@example.com" });
  });

  test("a callback for another user or a reused state is refused", async () => {
    const server = openai();
    const auth = new ChatGPTAuth(memory(), server.fetcher);
    const { url } = auth.start({ userId: "u1", redirectUri: REDIRECT });
    const state = startParams(url).state!;
    await expect(auth.complete({ userId: "someone-else", params: new URLSearchParams({ code: "c", state, client_id: ISSUED }) })).rejects.toThrow("expired");
    await expect(auth.complete({ userId: "u1", params: new URLSearchParams({ code: "c", state, client_id: ISSUED }) })).rejects.toThrow("expired");
    expect(server.forms).toHaveLength(0);
  });

  test("an ID token with the wrong nonce is rejected and nothing is saved", async () => {
    const storage = memory();
    const server = openai();
    const auth = new ChatGPTAuth(storage, server.fetcher);
    const { url } = auth.start({ userId: "u1", redirectUri: REDIRECT });
    server.setNonce("a-different-nonce");
    await expect(auth.complete({ userId: "u1", params: new URLSearchParams({ code: "c", state: startParams(url).state!, client_id: ISSUED }) })).rejects.toThrow("did not match");
    expect(storage.data.session).toBeNull();
  });

  test("a declined consent stops before any code exchange", async () => {
    const server = openai();
    const auth = new ChatGPTAuth(memory(), server.fetcher);
    const { url } = auth.start({ userId: "u1", redirectUri: REDIRECT });
    await expect(auth.complete({ userId: "u1", params: new URLSearchParams({ error: "access_denied", state: startParams(url).state! }) })).rejects.toThrow("cancelled");
    expect(server.forms).toHaveLength(0);
  });

  test("a sign-in without the plan scope keeps the identity but turns plan use off", async () => {
    const storage = memory();
    const server = openai({ scope: "email offline_access openid profile" });
    const auth = new ChatGPTAuth(storage, server.fetcher);
    const { result } = await signIn(auth, server);
    expect(result.planEnabled).toBe(false);
    await expect(auth.accessToken()).rejects.toThrow("plan use is off");
  });

  test("a returning sign-in reuses the issued client, drops the name hint and sends the ID token hint", async () => {
    const storage = memory();
    const server = openai();
    const auth = new ChatGPTAuth(storage, server.fetcher);
    await signIn(auth, server);
    const { params } = await signIn(auth, server);
    expect(params.client_id).toBe(ISSUED);
    expect(params.agent_name_hint).toBeUndefined();
    expect(params.id_token_hint).toBeTruthy();
    expect(params.login_hint).toBe("owner@example.com");
    expect(params.ext_agent_host_id).toBe(HOST);
    const consent = startParams(auth.start({ userId: "u1", redirectUri: REDIRECT, consent: true }).url);
    expect(consent.prompt).toBe("consent");
  });

  test("a returning sign-in to a different account is refused", async () => {
    const storage = memory();
    const first = openai();
    await signIn(new ChatGPTAuth(storage, first.fetcher), first);
    const other = openai({ subject: "user-2" });
    await expect(signIn(new ChatGPTAuth(storage, other.fetcher), other)).rejects.toThrow("different ChatGPT account");
    expect(storage.data.session!.subject).toBe("user-1");
  });

  test("refresh sends the issued client and resource, and concurrent callers share one refresh", async () => {
    const storage = memory();
    const server = openai();
    let now = Date.now();
    const auth = new ChatGPTAuth(storage, server.fetcher, () => now);
    await signIn(auth, server);
    expect(await auth.accessToken()).toBe("access-1");
    now += 3_600_000;
    const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()]);
    expect(a).toBe(b);
    const refreshes = server.forms.filter((entry) => entry.form.grant_type === "refresh_token");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]!.form).toEqual({ grant_type: "refresh_token", client_id: ISSUED, refresh_token: "refresh-1", resource: "https://api.openai.com/v1" });
    expect(storage.data.session!.refreshToken).toBe("refresh-2");
  });

  test("sign-out revokes the refresh token and keeps the client mapping", async () => {
    const storage = memory();
    const server = openai();
    const auth = new ChatGPTAuth(storage, server.fetcher);
    await signIn(auth, server);
    expect(await auth.signOut()).toEqual({ revoked: true });
    const revoke = server.forms.find((entry) => entry.url.endsWith("/revoke"))!.form;
    expect(revoke).toEqual({ token: "refresh-1", token_type_hint: "refresh_token", client_id: ISSUED });
    expect(storage.data.session).toBeNull();
    expect(storage.data.account?.clientId).toBe(ISSUED);
  });
});
