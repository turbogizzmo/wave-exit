/**
 * How Wave Exit proves who it is to Wave. Two kinds, behind one interface, so the
 * readers don't care which the user has:
 *
 * - A **Full Access key** the user creates in Wave's developer portal. Works on
 *   every Wave plan, never expires, but grants full read/write to everything the
 *   user can see. Wave's docs recommend it only for personal use; whether a
 *   distributed app may use it is an open question with Wave (docs/wave-api.md).
 * - **OAuth** ("Connect to Wave"). Read-only scopes, but Wave allows it only for
 *   businesses on Pro or Wave Advisor, and its token exchange needs the app's client
 *   secret, so code exchange and refresh go through an injected exchanger (a small
 *   token-exchange service in production). This module never holds the secret.
 */

export interface WaveCredentials {
  readonly kind: "full-access" | "oauth";
  /** A currently valid access token. */
  accessToken(): Promise<string>;
  /** After Wave rejects a token: try to get a fresh one. True if a retry may work. */
  refresh(): Promise<boolean>;
}

export function fullAccessKey(key: string): WaveCredentials {
  const token = key.trim();
  return {
    kind: "full-access",
    accessToken: async () => token,
    refresh: async () => false,
  };
}

/** The read-only scopes Wave Exit needs. Wave's scopes page: write never implies read. */
export const WAVE_READ_SCOPES = [
  "user:read",
  "business:read",
  "account:read",
  "customer:read",
  "vendor:read",
  "product:read",
  "sales_tax:read",
  "invoice:read",
  "estimate:read",
] as const;

export const WAVE_AUTHORIZE_URL = "https://api.waveapps.com/oauth2/authorize/";
export const WAVE_TOKEN_URL = "https://api.waveapps.com/oauth2/token/";

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope?: string;
  /** Set by Wave when the grant is limited to one business. */
  businessId?: string;
  userId?: string;
}

/** Wave's token endpoint response (OAuth Guide, step 2). */
export interface WaveTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  refresh_token: string;
  userId?: string;
  businessId?: string;
}

export function tokensFromResponse(r: WaveTokenResponse, now = Date.now()): OAuthTokens {
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiresAt: now + r.expires_in * 1000,
    ...(r.scope ? { scope: r.scope } : {}),
    ...(r.businessId ? { businessId: r.businessId } : {}),
    ...(r.userId ? { userId: r.userId } : {}),
  };
}

export function waveAuthorizeUrl(p: {
  clientId: string;
  redirectUri: string;
  state: string;
  businessId?: string;
  scopes?: readonly string[];
}): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    response_type: "code",
    scope: (p.scopes ?? WAVE_READ_SCOPES).join(" "),
    redirect_uri: p.redirectUri,
    state: p.state,
  });
  if (p.businessId) q.set("businessId", p.businessId);
  return `${WAVE_AUTHORIZE_URL}?${q}`;
}

/**
 * OAuth credentials. `refresher` swaps a refresh token for new tokens (through the
 * token-exchange service, which adds the client secret). `onTokens` lets the app
 * store the rotated tokens in the OS keychain: Wave invalidates the old access
 * token on refresh.
 */
export function oauthCredentials(p: {
  tokens: OAuthTokens;
  refresher: (refreshToken: string) => Promise<OAuthTokens>;
  onTokens?: (t: OAuthTokens) => void | Promise<void>;
  now?: () => number;
  /** Refresh this long before expiry. */
  skewMs?: number;
}): WaveCredentials {
  let tokens = p.tokens;
  const now = p.now ?? Date.now;
  const skew = p.skewMs ?? 60_000;
  let inflight: Promise<boolean> | undefined;

  const doRefresh = (): Promise<boolean> => {
    inflight ??= (async () => {
      try {
        tokens = await p.refresher(tokens.refreshToken);
        await p.onTokens?.(tokens);
        return true;
      } catch {
        return false;
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };

  return {
    kind: "oauth",
    async accessToken() {
      if (now() >= tokens.expiresAt - skew) await doRefresh();
      return tokens.accessToken;
    },
    refresh: doRefresh,
  };
}
