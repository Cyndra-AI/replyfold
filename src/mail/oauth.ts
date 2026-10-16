import { createHash } from "node:crypto";
import { z } from "zod";
import { randomToken } from "../core/secrets";

export type OAuthProviderKind = "gmail" | "microsoft";

export type OAuthClient = { clientId: string; clientSecret: string; tenant?: string };

type ProviderSpec = {
  label: string;
  authorizeUrl: (client: OAuthClient) => string;
  tokenUrl: (client: OAuthClient) => string;
  scopes: string[];
  extraParams: Record<string, string>;
  identityUrl: string;
  readIdentity: (body: unknown) => { email: string; name: string };
};

const googleProfile = z.object({ emailAddress: z.string().email() });
const microsoftProfile = z.object({
  mail: z.string().nullish(),
  userPrincipalName: z.string(),
  displayName: z.string().nullish(),
});

export const OAUTH_PROVIDERS: Record<OAuthProviderKind, ProviderSpec> = {
  gmail: {
    label: "Google",
    authorizeUrl: () => "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: () => "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    extraParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    identityUrl: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    readIdentity: (body) => {
      const profile = googleProfile.parse(body);
      return { email: profile.emailAddress.toLowerCase(), name: "" };
    },
  },
  microsoft: {
    label: "Microsoft",
    authorizeUrl: (client) => `https://login.microsoftonline.com/${client.tenant || "common"}/oauth2/v2.0/authorize`,
    tokenUrl: (client) => `https://login.microsoftonline.com/${client.tenant || "common"}/oauth2/v2.0/token`,
    scopes: [
      "offline_access",
      "https://graph.microsoft.com/User.Read",
      "https://graph.microsoft.com/Mail.ReadWrite",
      "https://graph.microsoft.com/Mail.Send",
    ],
    extraParams: { prompt: "select_account", response_mode: "query" },
    identityUrl: "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName",
    readIdentity: (body) => {
      const profile = microsoftProfile.parse(body);
      return { email: (profile.mail || profile.userPrincipalName).toLowerCase(), name: profile.displayName ?? "" };
    },
  },
};

export type OAuthTokens = { accessToken: string; refreshToken: string; expiresAt: number };

const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().positive(),
});

export class OAuthError extends Error {
  override name = "OAuthError";
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

async function requestTokens(fetcher: Fetch, url: string, form: Record<string, string>): Promise<z.infer<typeof tokenResponse>> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new OAuthError(`The provider rejected the sign-in (HTTP ${response.status}). Check the OAuth app settings.`);
  return tokenResponse.parse(await response.json());
}

type Pending = { provider: OAuthProviderKind; userId: string; verifier: string; expiresAt: number };

/** Authorization code flow with PKCE for every OAuth mailbox provider. */
export class OAuthFlow {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly clients: Partial<Record<OAuthProviderKind, OAuthClient>>,
    private readonly redirectBase: string,
    private readonly fetcher: Fetch = fetch,
  ) {}

  configured(provider: OAuthProviderKind) {
    const client = this.clients[provider];
    return Boolean(client?.clientId && client.clientSecret);
  }

  redirectUri(provider: OAuthProviderKind) {
    return `${this.redirectBase.replace(/\/$/, "")}/api/oauth/${provider}/callback`;
  }

  private client(provider: OAuthProviderKind) {
    const client = this.clients[provider];
    if (!client?.clientId || !client.clientSecret) {
      throw new OAuthError(`${OAUTH_PROVIDERS[provider].label} sign-in is not set up. Add its client ID and secret to .env.`);
    }
    return client;
  }

  start(provider: OAuthProviderKind, userId: string, now = Date.now()) {
    const client = this.client(provider);
    for (const [key, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(key);
    const state = randomToken();
    const verifier = randomToken(48);
    this.pending.set(state, { provider, userId, verifier, expiresAt: now + 10 * 60_000 });
    const spec = OAUTH_PROVIDERS[provider];
    const params = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: this.redirectUri(provider),
      response_type: "code",
      scope: spec.scopes.join(" "),
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      ...spec.extraParams,
    });
    return { url: `${spec.authorizeUrl(client)}?${params}`, state };
  }

  async complete(provider: OAuthProviderKind, input: { state: string; code: string; userId: string }, now = Date.now()) {
    const pending = this.pending.get(input.state);
    this.pending.delete(input.state);
    if (!pending || pending.provider !== provider || pending.userId !== input.userId || pending.expiresAt <= now) {
      throw new OAuthError("This sign-in link expired. Start the connection again.");
    }
    const client = this.client(provider);
    const spec = OAUTH_PROVIDERS[provider];
    const tokens = await requestTokens(this.fetcher, spec.tokenUrl(client), {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: this.redirectUri(provider),
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code_verifier: pending.verifier,
    });
    if (!tokens.refresh_token) throw new OAuthError("The provider did not grant offline access. Remove the app from your account and connect again.");
    const identityResponse = await this.fetcher(spec.identityUrl, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!identityResponse.ok) throw new OAuthError(`Could not read the mailbox address (HTTP ${identityResponse.status}).`);
    const identity = spec.readIdentity(await identityResponse.json());
    const result: OAuthTokens = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: now + tokens.expires_in * 1000,
    };
    return { tokens: result, identity };
  }

  async refresh(provider: OAuthProviderKind, refreshToken: string, now = Date.now()): Promise<OAuthTokens> {
    const client = this.client(provider);
    const tokens = await requestTokens(this.fetcher, OAUTH_PROVIDERS[provider].tokenUrl(client), {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      ...(provider === "microsoft" ? { scope: OAUTH_PROVIDERS.microsoft.scopes.join(" ") } : {}),
    });
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? refreshToken,
      expiresAt: now + tokens.expires_in * 1000,
    };
  }
}

/**
 * Hands out a valid access token, refreshing a minute early. Concurrent callers
 * share one refresh so a rotated refresh token is never used twice.
 */
export class TokenSource {
  private inflight: Promise<string> | null = null;

  constructor(
    private tokens: OAuthTokens,
    private readonly refresher: (refreshToken: string) => Promise<OAuthTokens>,
    private readonly persist: (tokens: OAuthTokens) => void,
  ) {}

  async accessToken(now = Date.now()): Promise<string> {
    if (this.tokens.expiresAt - 60_000 > now) return this.tokens.accessToken;
    this.inflight ??= this.refresher(this.tokens.refreshToken)
      .then((next) => {
        this.tokens = next;
        this.persist(next);
        return next.accessToken;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}
