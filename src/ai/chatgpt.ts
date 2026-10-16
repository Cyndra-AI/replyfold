import { createHash } from "node:crypto";
import { z } from "zod";
import { randomToken } from "../core/secrets";
import { ChatGPTPlanError } from "./providers";
import type { Fetch } from "./model";

/**
 * "Sign in with ChatGPT" with ChatGPT plan usage, for open-source and locally hosted apps.
 * Every value here comes from https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 */
export const CHATGPT = {
  issuer: "https://auth.openai.com",
  discovery: "https://auth.openai.com/.well-known/openid-configuration",
  authorize: "https://auth.openai.com/api/accounts/authorize",
  token: "https://auth.openai.com/api/accounts/oauth/token",
  resource: "https://api.openai.com/v1",
  dynamicClient: "dynamic_agent_client",
  scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
  planScope: "chatgpt.tokens.use.direct",
  appName: "Replyfold",
  callbackPath: "/auth/callback",
  usageUrl: "https://chatgpt.com/settings/usage",
} as const;

export type ChatGPTSession = {
  email: string;
  issuer: string;
  subject: string;
  clientId: string;
  hostId: string;
  idToken: string;
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: number;
  scopes: string[];
  savedAt: string;
};

/** What stays after sign-out, so the next sign-in reuses the issued client ID, as the docs require. */
export type ChatGPTAccount = { clientId: string; subject: string; email: string };

export type ChatGPTStorage = {
  hostId(): string;
  session(): ChatGPTSession | null;
  saveSession(session: ChatGPTSession | null): void;
  account(): ChatGPTAccount | null;
  saveAccount(account: ChatGPTAccount): void;
};

export class ChatGPTSignInError extends Error {
  override name = "ChatGPTSignInError";
}

type Pending = {
  userId: string;
  verifier: string;
  nonce: string;
  redirectUri: string;
  /** Null for a first registration through the dynamic client. */
  clientId: string | null;
  subject: string | null;
  expiresAt: number;
};

const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().min(1).optional(),
  token_type: z.string().default("Bearer"),
  expires_in: z.coerce.number().positive(),
  scope: z.string().default(""),
});

const Discovery = z.object({ issuer: z.string(), jwks_uri: z.string().url(), revocation_endpoint: z.string().url().optional() });
const Jwks = z.object({ keys: z.array(z.record(z.string(), z.unknown())) });

const UNUSABLE_REFRESH = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);

/** Only `127.0.0.1` callbacks are allowed. The port may change between sign-ins; the path may not. */
export function loopbackRedirect(url: URL) {
  if (url.hostname !== "127.0.0.1") return null;
  return `http://127.0.0.1:${url.port || "80"}${CHATGPT.callbackPath}`;
}

function decodeSegment(segment: string) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

export async function verifyIdToken(
  token: string,
  expected: { issuer: string; audience: string; nonce: string; keys: Array<Record<string, unknown>>; now: number },
) {
  const [headerPart, payloadPart, signaturePart] = token.split(".");
  if (!headerPart || !payloadPart || !signaturePart) throw new ChatGPTSignInError("ChatGPT sent an ID token in an unknown format.");
  const header = decodeSegment(headerPart) as { alg?: string; kid?: string };
  const payload = decodeSegment(payloadPart) as { iss?: string; aud?: string | string[]; exp?: number; nonce?: string; sub?: string; email?: string };
  const jwk = expected.keys.find((key) => key.kid === header.kid) ?? (expected.keys.length === 1 ? expected.keys[0] : undefined);
  if (!jwk) throw new ChatGPTSignInError("ChatGPT signed the ID token with an unknown key.");
  const algorithms: Record<string, { import: RsaHashedImportParams | EcKeyImportParams; verify: AlgorithmIdentifier | EcdsaParams }> = {
    RS256: { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: "RSASSA-PKCS1-v1_5" },
    ES256: { import: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } },
  };
  const algorithm = header.alg ? algorithms[header.alg] : undefined;
  if (!algorithm) throw new ChatGPTSignInError("ChatGPT signed the ID token with an unsupported algorithm.");
  const key = await crypto.subtle.importKey("jwk", jwk as JsonWebKey, algorithm.import, false, ["verify"]);
  const valid = await crypto.subtle.verify(algorithm.verify, key, Buffer.from(signaturePart, "base64url"), new TextEncoder().encode(`${headerPart}.${payloadPart}`));
  if (!valid) throw new ChatGPTSignInError("The ChatGPT ID token signature is not valid.");
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== expected.issuer) throw new ChatGPTSignInError("The ChatGPT ID token has the wrong issuer.");
  if (!audiences.includes(expected.audience)) throw new ChatGPTSignInError("The ChatGPT ID token was issued for another app.");
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= expected.now) throw new ChatGPTSignInError("The ChatGPT ID token has expired. Sign in again.");
  if (payload.nonce !== expected.nonce) throw new ChatGPTSignInError("The ChatGPT sign-in did not match this attempt. Sign in again.");
  if (!payload.sub) throw new ChatGPTSignInError("The ChatGPT ID token has no account identity.");
  return { subject: payload.sub, email: payload.email ?? "" };
}

export class ChatGPTAuth {
  private readonly pending = new Map<string, Pending>();
  private discovery: z.infer<typeof Discovery> | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly storage: ChatGPTStorage,
    private readonly fetcher: Fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  private async discover() {
    if (this.discovery) return this.discovery;
    const response = await this.fetcher(CHATGPT.discovery, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new ChatGPTSignInError(`Could not reach OpenAI sign-in (HTTP ${response.status}).`);
    this.discovery = Discovery.parse(await response.json());
    return this.discovery;
  }

  /**
   * Builds the authorization URL. A first sign-in registers this app through the dynamic client;
   * later sign-ins reuse the issued client ID. `consent` asks again for plan usage after a decline.
   */
  start(input: { userId: string; redirectUri: string; consent?: boolean; newAccount?: boolean }) {
    const now = this.clock();
    for (const [key, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(key);
    const account = input.newAccount ? null : this.storage.account();
    const session = this.storage.session();
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken(48);
    this.pending.set(state, {
      userId: input.userId,
      verifier,
      nonce,
      redirectUri: input.redirectUri,
      clientId: account?.clientId ?? null,
      subject: account?.subject ?? null,
      expiresAt: now + 10 * 60_000,
    });
    const params = new URLSearchParams({
      client_id: account?.clientId ?? CHATGPT.dynamicClient,
      ...(account ? {} : { agent_name_hint: CHATGPT.appName }),
      ext_agent_host_id: this.storage.hostId(),
      ...(account && session?.clientId === account.clientId && session.idToken ? { id_token_hint: session.idToken } : {}),
      ...(account?.email ? { login_hint: account.email } : {}),
      response_type: "code",
      redirect_uri: input.redirectUri,
      scope: CHATGPT.scope,
      resource: CHATGPT.resource,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      ...(input.consent ? { prompt: "consent" } : {}),
    });
    return { url: `${CHATGPT.authorize}?${params}`, state };
  }

  /** Handles the loopback callback: checks state, exchanges the code with PKCE, validates the ID token and scopes. */
  async complete(input: { userId: string; params: URLSearchParams }) {
    const state = input.params.get("state") ?? "";
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.userId !== input.userId || pending.expiresAt <= this.clock()) {
      throw new ChatGPTSignInError("This sign-in link expired. Start again from Settings.");
    }
    const error = input.params.get("error");
    if (error) {
      throw new ChatGPTSignInError(error === "access_denied" ? "The ChatGPT sign-in was cancelled. Replyfold will not use your ChatGPT plan." : "ChatGPT could not finish the sign-in. Try again.");
    }
    const returned = input.params.get("client_id");
    let clientId: string;
    if (pending.clientId) {
      if (returned && returned !== pending.clientId) throw new ChatGPTSignInError("ChatGPT returned a different app registration. Nothing was changed.");
      clientId = pending.clientId;
    } else {
      if (!returned || returned === CHATGPT.dynamicClient) throw new ChatGPTSignInError("ChatGPT did not finish registering Replyfold. Try again.");
      clientId = returned;
    }
    const code = input.params.get("code");
    if (!code) throw new ChatGPTSignInError("ChatGPT did not return a sign-in code. Try again.");

    const response = await this.fetcher(CHATGPT.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: pending.verifier,
        redirect_uri: pending.redirectUri,
        resource: CHATGPT.resource,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new ChatGPTSignInError(`ChatGPT refused the sign-in code (HTTP ${response.status}). Start again from Settings.`);
    const tokens = TokenResponse.parse(await response.json());
    if (!tokens.id_token) throw new ChatGPTSignInError("ChatGPT did not return an ID token.");
    const discovery = await this.discover();
    const jwks = await this.fetcher(discovery.jwks_uri, { signal: AbortSignal.timeout(20_000) });
    if (!jwks.ok) throw new ChatGPTSignInError("Could not load OpenAI's signing keys.");
    const now = this.clock();
    const identity = await verifyIdToken(tokens.id_token, { issuer: discovery.issuer, audience: clientId, nonce: pending.nonce, keys: Jwks.parse(await jwks.json()).keys, now });
    if (pending.subject && identity.subject !== pending.subject) throw new ChatGPTSignInError("You signed in to a different ChatGPT account. Use \"Use another account\" instead.");

    const scopes = tokens.scope.split(/\s+/).filter(Boolean);
    const session: ChatGPTSession = {
      email: identity.email,
      issuer: discovery.issuer,
      subject: identity.subject,
      clientId,
      hostId: this.storage.hostId(),
      idToken: tokens.id_token,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenType: tokens.token_type,
      expiresAt: now + tokens.expires_in * 1000,
      scopes,
      savedAt: new Date(now).toISOString(),
    };
    this.storage.saveSession(session);
    this.storage.saveAccount({ clientId, subject: identity.subject, email: identity.email });
    return { email: identity.email, planEnabled: scopes.includes(CHATGPT.planScope) };
  }

  /** A valid access token, refreshed near expiry. Concurrent callers share one refresh, since refresh tokens rotate. */
  async accessToken(): Promise<string> {
    const session = this.storage.session();
    if (!session) throw new ChatGPTPlanError("ChatGPT is not connected. Connect it in Settings.", "signed_out");
    if (!session.scopes.includes(CHATGPT.planScope)) throw new ChatGPTPlanError("ChatGPT plan use is off. Turn it on in Settings.", "signed_out");
    if (session.expiresAt - 60_000 > this.clock()) return session.accessToken;
    this.refreshing ??= this.refresh(session).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(session: ChatGPTSession) {
    const response = await this.fetcher(CHATGPT.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: session.clientId, refresh_token: session.refreshToken, resource: CHATGPT.resource }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      let code = "";
      try {
        const body = (await response.json()) as { error?: string | { code?: string } };
        code = typeof body.error === "string" ? body.error : (body.error?.code ?? "");
      } catch {
        code = "";
      }
      if (UNUSABLE_REFRESH.has(code)) {
        this.storage.saveSession(null);
        throw new ChatGPTPlanError("The ChatGPT sign-in ended. Connect ChatGPT again in Settings.", "signed_out");
      }
      throw new ChatGPTPlanError(`ChatGPT could not renew the sign-in (HTTP ${response.status}). Replyfold will try again.`, "other");
    }
    const tokens = TokenResponse.parse(await response.json());
    const scopes = tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : session.scopes;
    const next: ChatGPTSession = {
      ...session,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: this.clock() + tokens.expires_in * 1000,
      scopes,
      ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
      savedAt: new Date(this.clock()).toISOString(),
    };
    this.storage.saveSession(next);
    return next.accessToken;
  }

  /** Revokes the refresh token, then clears the tokens. The account and client mapping stay for the next sign-in. */
  async signOut(): Promise<{ revoked: boolean }> {
    const session = this.storage.session();
    if (!session) return { revoked: true };
    let revoked = false;
    try {
      const discovery = await this.discover();
      if (discovery.revocation_endpoint) {
        for (let attempt = 0; attempt < 3 && !revoked; attempt += 1) {
          try {
            const response = await this.fetcher(discovery.revocation_endpoint, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ token: session.refreshToken, token_type_hint: "refresh_token", client_id: session.clientId }),
              signal: AbortSignal.timeout(10_000),
            });
            if (response.ok) revoked = true;
            else if (response.status < 500) break;
          } catch {
            // A network failure is retried.
          }
          if (!revoked && attempt < 2) await Bun.sleep(250 * (attempt + 1));
        }
      }
    } catch {
      revoked = false;
    }
    this.storage.saveSession(null);
    return { revoked };
  }
}
