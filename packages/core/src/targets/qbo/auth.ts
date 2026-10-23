import type { QboCredentials } from "./client.ts";

/**
 * Signing in to QuickBooks Online (developer.intuit.com "Set up OAuth 2.0", read
 * 2026-10-23). The user approves Wave Exit in Intuit's page in their browser; Intuit
 * redirects back with a one-time code and the company's realm ID. Exchanging the code
 * (and later refreshing) needs the app's client secret, which can't ship inside a
 * desktop app, so both go through an exchanger:
 *   - development: the developer's own Intuit keys, kept in an untracked local file;
 *   - release: Wave Exit's small token-exchange service (packages/token-exchange),
 *     which only swaps codes and refresh tokens for tokens and sees no accounting data.
 * Sandbox keys may redirect to http://localhost; production keys need an https
 * redirect, which the token-exchange service also hosts.
 */

export const INTUIT_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
export const INTUIT_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const INTUIT_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
export const QBO_SCOPE = "com.intuit.quickbooks.accounting";

export interface IntuitTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. Access tokens last an hour. */
  expiresAt: number;
  /** Epoch ms. Refresh tokens roll for 100 days (5-year hard limit). */
  refreshExpiresAt: number;
}

/** Intuit's token endpoint response. */
export interface IntuitTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
  token_type: string;
}

export function tokensFrom(r: IntuitTokenResponse, now = Date.now()): IntuitTokens {
  return { accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: now + r.expires_in * 1000, refreshExpiresAt: now + r.x_refresh_token_expires_in * 1000 };
}

/** Swaps a code or refresh token for tokens: holds the client secret (dev file or the exchange service). */
export interface IntuitExchanger {
  exchangeCode(code: string, redirectUri: string): Promise<IntuitTokens>;
  refresh(refreshToken: string): Promise<IntuitTokens>;
}

export function intuitAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string }): string {
  const q = new URLSearchParams({ client_id: p.clientId, response_type: "code", scope: QBO_SCOPE, redirect_uri: p.redirectUri, state: p.state });
  return `${INTUIT_AUTHORIZE_URL}?${q}`;
}

/** Read Intuit's redirect: code, state and the company (realm) the user picked. */
export function parseIntuitRedirect(url: string, expectedState: string): { code: string; realmId: string } {
  const u = new URL(url);
  const err = u.searchParams.get("error");
  if (err) throw new Error(err === "access_denied" ? "You cancelled the connection in QuickBooks." : `QuickBooks returned an error: ${err}`);
  if (u.searchParams.get("state") !== expectedState) throw new Error("The sign-in reply didn't match this request. Start again.");
  const code = u.searchParams.get("code");
  const realmId = u.searchParams.get("realmId");
  if (!code || !realmId) throw new Error("QuickBooks didn't say which company was chosen. Start again.");
  return { code, realmId };
}

/** A direct exchanger for development: the developer's own client ID and secret, never shipped. */
export function directExchanger(p: { clientId: string; clientSecret: string; fetch?: typeof fetch }): IntuitExchanger {
  const f = p.fetch ?? fetch;
  const post = async (body: Record<string, string>) => {
    const res = await f(INTUIT_TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${p.clientId}:${p.clientSecret}`)}` },
      body: new URLSearchParams(body).toString(),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Intuit token request failed (${res.status}): ${text.slice(0, 300)}`);
    return tokensFrom(JSON.parse(text) as IntuitTokenResponse);
  };
  return {
    exchangeCode: (code, redirectUri) => post({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    refresh: (refreshToken) => post({ grant_type: "refresh_token", refresh_token: refreshToken }),
  };
}

/** An exchanger that calls Wave Exit's token-exchange service. */
export function serviceExchanger(p: { baseUrl: string; fetch?: typeof fetch }): IntuitExchanger {
  const f = p.fetch ?? fetch;
  const post = async (path: string, body: Record<string, string>) => {
    const res = await f(`${p.baseUrl.replace(/\/$/, "")}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Sign-in service error (${res.status}): ${text.slice(0, 300)}`);
    return tokensFrom(JSON.parse(text) as IntuitTokenResponse);
  };
  return {
    exchangeCode: (code, redirectUri) => post("/intuit/token", { code, redirect_uri: redirectUri }),
    refresh: (refreshToken) => post("/intuit/refresh", { refresh_token: refreshToken }),
  };
}

/** Credentials for QboClient: refreshes ahead of expiry and hands rotated tokens to `onTokens` (keychain). */
export function intuitCredentials(p: {
  tokens: IntuitTokens;
  exchanger: IntuitExchanger;
  onTokens: (t: IntuitTokens) => void | Promise<void>;
  now?: () => number;
}): QboCredentials {
  let tokens = p.tokens;
  const now = p.now ?? Date.now;
  let inflight: Promise<boolean> | undefined;
  const refresh = () =>
    (inflight ??= (async () => {
      try {
        tokens = await p.exchanger.refresh(tokens.refreshToken);
        await p.onTokens(tokens);
        return true;
      } catch {
        return false;
      } finally {
        inflight = undefined;
      }
    })());
  return {
    async accessToken() {
      if (now() > tokens.expiresAt - 120_000) await refresh();
      return tokens.accessToken;
    },
    refresh,
  };
}
