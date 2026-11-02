import { describe, expect, it } from "vitest";
import { handle, INTUIT_TOKEN_URL, type Env, type RateLimiter } from "../src/index.ts";

/** Allows `max` requests per key, like a Workers rate-limit binding. */
function limiter(max = 100): RateLimiter & { keys: string[] } {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { success: counts.get(key)! <= max };
    },
  };
}

const base = { INTUIT_CLIENT_ID: "cid", INTUIT_CLIENT_SECRET: "secret", ALLOWED_REDIRECT_URIS: "https://signin.example/intuit/callback" };
const env: Env = { ...base, IP_LIMITER: limiter(), TOKEN_LIMITER: limiter() };

function fakeIntuit() {
  const calls: { url: string; auth: string; body: string }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: String((init.headers as Record<string, string>).Authorization), body: String(init.body) });
    return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600, x_refresh_token_expires_in: 8640000, token_type: "bearer", extra: "dropped" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const post = (path: string, body: unknown, headers: Record<string, string> = { Origin: "tauri://localhost" }) =>
  new Request(`https://signin.example${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("token-exchange service", () => {
  it("sends the sign-in reply straight back to the app on the user's computer", async () => {
    const state = "0123456789abcdef0123456789abcdef";
    const r = await handle(new Request(`https://signin.example/intuit/callback?code=c1&state=${state}&realmId=42`), env);
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe(`http://127.0.0.1:53682/callback?code=c1&state=${state}&realmId=42`);
    expect((await handle(new Request("https://signin.example/intuit/callback?code=c1&state=80.abc"), env)).status).toBe(400);
    expect((await handle(new Request("https://signin.example/intuit/callback?code=c1&state=evil.com"), env)).status).toBe(400);
    expect((await handle(new Request("https://signin.example/intuit/callback?code=c1"), env)).status).toBe(400);
  });

  it("never sends the reply to a port the request picks", async () => {
    const r = await handle(new Request(`https://signin.example/intuit/callback?code=c1&state=8080.${"a".repeat(32)}`), env);
    expect(r.status).toBe(400);
  });

  it("refuses an oversized body before reading it", async () => {
    const { f, calls } = fakeIntuit();
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1024).fill(32));
        if (pulled > 1000) c.close();
      },
    });
    const req = new Request("https://signin.example/intuit/refresh", { method: "POST", body, duplex: "half", headers: { "Content-Type": "application/json", Origin: "tauri://localhost" } } as RequestInit);
    expect((await handle(req, env, f)).status).toBe(400);
    expect(pulled).toBeLessThan(10);
    const declared = new Request("https://signin.example/intuit/refresh", { method: "POST", body: "{}", headers: { "Content-Type": "application/json", "Content-Length": "5000000", Origin: "tauri://localhost" } });
    expect((await handle(declared, env, f)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("exchanges a code with the client secret, only for its own redirect", async () => {
    const { f, calls } = fakeIntuit();
    const r = await handle(post("/intuit/token", { code: "c1", redirect_uri: "https://signin.example/intuit/callback" }), env, f);
    expect(await r.json()).toEqual({ access_token: "a", refresh_token: "r", expires_in: 3600, x_refresh_token_expires_in: 8640000, token_type: "bearer" });
    expect(calls[0]!.url).toBe(INTUIT_TOKEN_URL);
    expect(calls[0]!.auth).toBe(`Basic ${btoa("cid:secret")}`);
    expect(calls[0]!.body).toContain("grant_type=authorization_code");
    const bad = await handle(post("/intuit/token", { code: "c1", redirect_uri: "https://attacker.example/cb" }), env, f);
    expect(bad.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("refreshes tokens", async () => {
    const { f, calls } = fakeIntuit();
    const r = await handle(post("/intuit/refresh", { refresh_token: "r1" }), env, f);
    expect(r.status).toBe(200);
    expect(calls[0]!.body).toBe("grant_type=refresh_token&refresh_token=r1");
  });

  it("refuses anything else", async () => {
    expect((await handle(new Request("https://signin.example/anything"), env)).status).toBe(404);
    expect((await handle(post("/intuit/refresh", {}), env)).status).toBe(400);
    expect((await handle(new Request("https://signin.example/intuit/refresh", { method: "POST", body: "x".repeat(5000), headers: { "Content-Type": "application/json", Origin: "tauri://localhost" } }), env)).status).toBe(400);
  });

  it("only answers the desktop app", async () => {
    const { f, calls } = fakeIntuit();
    expect((await handle(post("/intuit/refresh", { refresh_token: "r1" }, { Origin: "https://attacker.example" }), env, f)).status).toBe(403);
    expect((await handle(post("/intuit/refresh", { refresh_token: "r1" }, {}), env, f)).status).toBe(403);
    expect((await handle(post("/intuit/token", { code: "c1", redirect_uri: "https://signin.example/intuit/callback" }, {}), env, f)).status).toBe(403);
    expect((await handle(post("/intuit/refresh", { refresh_token: "r1" }, { Origin: "http://tauri.localhost" }), env, f)).status).toBe(200);
    const custom: Env = { ...env, ALLOWED_ORIGINS: "http://localhost:5173" };
    expect((await handle(post("/intuit/refresh", { refresh_token: "r1" }, { Origin: "http://localhost:5173" }), custom, f)).status).toBe(200);
    expect((await handle(post("/intuit/refresh", { refresh_token: "r1" }), custom, f)).status).toBe(403);
    expect(calls).toHaveLength(2);
  });

  it("refuses to run without rate limiting", async () => {
    const { f, calls } = fakeIntuit();
    const r = await handle(post("/intuit/refresh", { refresh_token: "r1" }), { ...base, IP_LIMITER: limiter() }, f);
    expect(r.status).toBe(503);
    expect((await handle(post("/intuit/refresh", { refresh_token: "r1" }), base, f)).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("rate limits per caller and per token", async () => {
    const { f, calls } = fakeIntuit();
    const ip = limiter(2);
    const perIp: Env = { ...base, IP_LIMITER: ip, TOKEN_LIMITER: limiter() };
    const from = (addr: string) => ({ Origin: "tauri://localhost", "CF-Connecting-IP": addr });
    expect((await handle(post("/intuit/refresh", { refresh_token: "a" }, from("1.1.1.1")), perIp, f)).status).toBe(200);
    expect((await handle(post("/intuit/refresh", { refresh_token: "b" }, from("1.1.1.1")), perIp, f)).status).toBe(200);
    expect((await handle(post("/intuit/refresh", { refresh_token: "c" }, from("1.1.1.1")), perIp, f)).status).toBe(429);
    expect((await handle(post("/intuit/refresh", { refresh_token: "c" }, from("2.2.2.2")), perIp, f)).status).toBe(200);
    expect(ip.keys[0]).toBe("ip:1.1.1.1");

    const tok = limiter(1);
    const perToken: Env = { ...base, IP_LIMITER: limiter(), TOKEN_LIMITER: tok };
    expect((await handle(post("/intuit/refresh", { refresh_token: "stolen" }), perToken, f)).status).toBe(200);
    expect((await handle(post("/intuit/refresh", { refresh_token: "stolen" }), perToken, f)).status).toBe(429);
    expect((await handle(post("/intuit/token", { code: "c1", redirect_uri: "https://signin.example/intuit/callback" }), perToken, f)).status).toBe(200);
    expect((await handle(post("/intuit/token", { code: "c1", redirect_uri: "https://signin.example/intuit/callback" }), perToken, f)).status).toBe(429);
    // Tokens are keyed by their hash, never stored as they are.
    expect(tok.keys.some((k) => k.includes("stolen") || k.includes("c1"))).toBe(false);
    expect(tok.keys[0]).toMatch(/^refresh:[0-9a-f]{64}$/);
    expect(calls).toHaveLength(5);
  });
});
