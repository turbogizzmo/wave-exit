/**
 * Wave Exit's token-exchange service.
 *
 * QuickBooks Online sign-in (Intuit OAuth 2.0) needs the app's client secret to
 * turn a sign-in code into tokens and to refresh them, and production apps must
 * redirect to an https address. A desktop app can do neither on its own, so this
 * small stateless service does exactly three things and nothing else:
 *
 *   GET  /intuit/callback?code&state&realmId  →  302 to http://127.0.0.1:<port>/callback?...
 *        (the https redirect Intuit calls; the port is the first part of `state`,
 *        so the reply goes straight back to the app on the user's own computer)
 *   POST /intuit/token   {code, redirect_uri}  →  Intuit's token response
 *   POST /intuit/refresh {refresh_token}       →  Intuit's token response
 *
 * It stores nothing, logs nothing, and never receives accounting data: only sign-in
 * codes and tokens pass through it. It is a standard fetch handler, so it runs on
 * Cloudflare Workers, Deno Deploy or any runtime with Request/Response.
 */

export interface Env {
  INTUIT_CLIENT_ID: string;
  INTUIT_CLIENT_SECRET: string;
  /** Comma-separated redirect URIs this service may exchange codes for (its own callback URL). */
  ALLOWED_REDIRECT_URIS: string;
}

export const INTUIT_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const MAX_BODY = 4096;

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  if (!req.headers.get("Content-Type")?.includes("application/json")) return null;
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
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
    const port = Number(state.split(".")[0]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return new Response("This sign-in link isn't from Wave Exit.", { status: 400 });
    const back = new URL(`http://127.0.0.1:${port}/callback`);
    for (const k of ["code", "state", "realmId", "error"]) {
      const v = url.searchParams.get(k);
      if (v) back.searchParams.set(k, v);
    }
    return new Response(null, { status: 302, headers: { Location: back.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }

  if (req.method === "POST" && url.pathname === "/intuit/token") {
    const b = await readJson(req);
    const code = typeof b?.code === "string" ? b.code : "";
    const redirect = typeof b?.redirect_uri === "string" ? b.redirect_uri : "";
    const allowed = env.ALLOWED_REDIRECT_URIS.split(",").map((s) => s.trim()).filter(Boolean);
    if (!code || !allowed.includes(redirect)) return json(400, { error: "invalid_request" });
    return intuit(env, { grant_type: "authorization_code", code, redirect_uri: redirect }, f);
  }

  if (req.method === "POST" && url.pathname === "/intuit/refresh") {
    const b = await readJson(req);
    const refresh = typeof b?.refresh_token === "string" ? b.refresh_token : "";
    if (!refresh) return json(400, { error: "invalid_request" });
    return intuit(env, { grant_type: "refresh_token", refresh_token: refresh }, f);
  }

  return json(404, { error: "not_found" });
}

export default { fetch: (req: Request, env: Env) => handle(req, env) };
