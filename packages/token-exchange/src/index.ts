/**
 * Wave Exit's token-exchange service.
 *
 * QuickBooks Online sign-in (Intuit OAuth 2.0) needs the app's client secret to
 * turn a sign-in code into tokens and to refresh them, and production apps must
 * redirect to an https address. A desktop app can do neither on its own, so this
 * small stateless service does exactly three things and nothing else:
 *
 *   GET  /intuit/callback?code&state&realmId  →  302 to http://127.0.0.1:53682/callback?...
 *        (the https redirect Intuit calls; the reply goes straight back to the app's
 *        fixed sign-in port on the user's own computer, and the app checks `state`)
 *   POST /intuit/token   {code, redirect_uri}  →  Intuit's token response
 *   POST /intuit/refresh {refresh_token}       →  Intuit's token response
 *
 * It stores nothing, logs nothing, and never receives accounting data: only sign-in
 * codes and tokens pass through it. It is a standard fetch handler, so it runs on
 * Cloudflare Workers, Deno Deploy or any runtime with Request/Response.
 *
 * The POST routes attach the client secret, so they only answer the desktop app and
 * are rate limited:
 *   - the app calls them through Tauri's HTTP plugin, which always sends the WebView's
 *     origin (tauri://localhost on macOS, http://tauri.localhost on Windows). Requests
 *     with any other Origin, or none, are refused, so a web page can't use the service
 *     and casual scripts have to go out of their way to;
 *   - every request is counted per caller IP and per code or refresh token (hashed),
 *     using rate-limit bindings (Cloudflare Workers' `ratelimit` binding or anything
 *     with the same `limit({ key })` shape). Without them the POST routes refuse to run.
 */

/** A rate limiter: Cloudflare Workers' `ratelimit` binding has exactly this shape. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  INTUIT_CLIENT_ID: string;
  INTUIT_CLIENT_SECRET: string;
  /** Comma-separated redirect URIs this service may exchange codes for (its own callback URL). */
  ALLOWED_REDIRECT_URIS: string;
  /** Comma-separated Origin values allowed to call the POST routes. Defaults to the desktop app's own (DEFAULT_ALLOWED_ORIGINS). */
  ALLOWED_ORIGINS?: string;
  /** Limits POST requests per caller IP. Required. */
  IP_LIMITER?: RateLimiter;
  /** Limits POST requests per code or refresh token (keyed by its SHA-256). Required. */
  TOKEN_LIMITER?: RateLimiter;
}

/** The origins Tauri's HTTP plugin sends for Wave Exit's WebView (macOS/Linux, Windows). */
export const DEFAULT_ALLOWED_ORIGINS = ["tauri://localhost", "http://tauri.localhost"];

export const INTUIT_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const MAX_BODY = 4096;

/** The app's sign-in listener (INTUIT_LOOPBACK_PORT in packages/app/src-tauri/src/lib.rs). Never taken from the request. */
export const APP_LOOPBACK_PORT = 53682;
/** The app's state: 16 random bytes as hex (QboLoad.tsx). */
const STATE = /^[0-9a-f]{32}$/;

/** Reads at most MAX_BODY bytes: a bigger declared or actual body is refused without buffering it. */
async function readText(req: Request): Promise<string | null> {
  if (Number(req.headers.get("Content-Length") ?? 0) > MAX_BODY) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  if (!req.headers.get("Content-Type")?.includes("application/json")) return null;
  const text = await readText(req);
  if (text === null) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

async function sha256(v: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Refuses callers that aren't the desktop app, or that are over their limit; null means go ahead. */
async function gate(req: Request, env: Env): Promise<Response | null> {
  if (!env.IP_LIMITER || !env.TOKEN_LIMITER) return json(503, { error: "server_misconfigured", error_description: "Rate limiting isn't set up (IP_LIMITER and TOKEN_LIMITER bindings)." });
  const allowed = env.ALLOWED_ORIGINS ? list(env.ALLOWED_ORIGINS) : DEFAULT_ALLOWED_ORIGINS;
  if (!allowed.includes(req.headers.get("Origin") ?? "")) return json(403, { error: "forbidden" });
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.IP_LIMITER.limit({ key: `ip:${ip}` })).success) return json(429, { error: "rate_limited" });
  return null;
}

async function tokenAllowed(env: Env, kind: string, value: string): Promise<boolean> {
  return (await env.TOKEN_LIMITER!.limit({ key: `${kind}:${await sha256(value)}` })).success;
}

async function intuit(env: Env, form: Record<string, string>, f: typeof fetch): Promise<Response> {
  const res = await f(INTUIT_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${env.INTUIT_CLIENT_ID}:${env.INTUIT_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  // Pass Intuit's answer through, minus anything but the token fields.
  try {
    const t = JSON.parse(text) as Record<string, unknown>;
    if (!res.ok) return json(res.status, { error: t.error ?? "intuit_error", error_description: t.error_description ?? "" });
    const keep = ["access_token", "refresh_token", "expires_in", "x_refresh_token_expires_in", "token_type"];
    return json(200, Object.fromEntries(keep.filter((k) => k in t).map((k) => [k, t[k]])));
  } catch {
    return json(502, { error: "bad_gateway" });
  }
}

export async function handle(req: Request, env: Env, f: typeof fetch = fetch): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/intuit/callback") {
    const state = url.searchParams.get("state") ?? "";
    if (!STATE.test(state)) return new Response("This sign-in link isn't from Wave Exit.", { status: 400 });
    const back = new URL(`http://127.0.0.1:${APP_LOOPBACK_PORT}/callback`);
    for (const k of ["code", "state", "realmId", "error"]) {
      const v = url.searchParams.get(k);
      if (v) back.searchParams.set(k, v);
    }
    return new Response(null, { status: 302, headers: { Location: back.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }

  if (req.method === "POST" && url.pathname === "/intuit/token") {
    const refused = await gate(req, env);
    if (refused) return refused;
    const b = await readJson(req);
    const code = typeof b?.code === "string" ? b.code : "";
    const redirect = typeof b?.redirect_uri === "string" ? b.redirect_uri : "";
    if (!code || !list(env.ALLOWED_REDIRECT_URIS).includes(redirect)) return json(400, { error: "invalid_request" });
    if (!(await tokenAllowed(env, "code", code))) return json(429, { error: "rate_limited" });
    return intuit(env, { grant_type: "authorization_code", code, redirect_uri: redirect }, f);
  }

  if (req.method === "POST" && url.pathname === "/intuit/refresh") {
    const refused = await gate(req, env);
    if (refused) return refused;
    const b = await readJson(req);
    const refresh = typeof b?.refresh_token === "string" ? b.refresh_token : "";
    if (!refresh) return json(400, { error: "invalid_request" });
    if (!(await tokenAllowed(env, "refresh", refresh))) return json(429, { error: "rate_limited" });
    return intuit(env, { grant_type: "refresh_token", refresh_token: refresh }, f);
  }

  return json(404, { error: "not_found" });
}

export default { fetch: (req: Request, env: Env) => handle(req, env) };
