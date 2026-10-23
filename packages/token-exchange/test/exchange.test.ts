import { describe, expect, it } from "vitest";
import { handle, INTUIT_TOKEN_URL, type Env } from "../src/index.ts";

const env: Env = { INTUIT_CLIENT_ID: "cid", INTUIT_CLIENT_SECRET: "secret", ALLOWED_REDIRECT_URIS: "https://signin.example/intuit/callback" };

function fakeIntuit() {
  const calls: { url: string; auth: string; body: string }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: String((init.headers as Record<string, string>).Authorization), body: String(init.body) });
    return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600, x_refresh_token_expires_in: 8640000, token_type: "bearer", extra: "dropped" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const post = (path: string, body: unknown) => new Request(`https://signin.example${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("token-exchange service", () => {
  it("sends the sign-in reply straight back to the app on the user's computer", async () => {
    const r = await handle(new Request("https://signin.example/intuit/callback?code=c1&state=53682.abc&realmId=42"), env);
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("http://127.0.0.1:53682/callback?code=c1&state=53682.abc&realmId=42");
    expect((await handle(new Request("https://signin.example/intuit/callback?code=c1&state=80.abc"), env)).status).toBe(400);
    expect((await handle(new Request("https://signin.example/intuit/callback?code=c1&state=evil.com"), env)).status).toBe(400);
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
    expect((await handle(new Request("https://signin.example/intuit/refresh", { method: "POST", body: "x".repeat(5000), headers: { "Content-Type": "application/json" } }), env)).status).toBe(400);
  });
});
