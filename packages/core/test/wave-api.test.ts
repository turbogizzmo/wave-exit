import { describe, expect, it } from "vitest";
import {
  fetchWaveSnapshot, fullAccessKey, InputProblem, ledgerTransactionId, listBusinesses, oauthCredentials,
  parseWaveSnapshot, waveAuthorizeUrl, WaveClient, whoAmI, type OAuthTokens,
} from "../src/index.ts";
import { ACCOUNTS, BUSINESS_ID, E, fakeWaveApi } from "./fixtures/synthetic.ts";

const noSleep = async () => {};
const client = (fetch: ReturnType<typeof fakeWaveApi>["fetch"], token = "key") =>
  new WaveClient({ credentials: fullAccessKey(token), fetch, minIntervalMs: 0, sleep: noSleep });

describe("Wave API reader", () => {
  it("reads a whole business into a snapshot", async () => {
    const api = fakeWaveApi({ pageSize: 2 }); // force several pages
    const snap = await fetchWaveSnapshot(client(api.fetch), BUSINESS_ID, { now: () => new Date("2026-01-16T00:00:00Z") });
    expect(snap.business).toMatchObject({ name: "Maple & Pine Design LLC", currency: { code: "USD", exponent: 2 } });
    expect(snap.connection).toBe("full-access");
    expect(snap.accounts).toHaveLength(ACCOUNTS.length);
    expect(snap.customers).toHaveLength(4);
    expect(snap.vendors).toHaveLength(5);
    expect(snap.invoices).toHaveLength(6);
    expect(api.calls.filter((c) => c.operation === "Accounts").length).toBeGreaterThan(2);
  });

  it("asks separately for archived accounts, which Wave hides by default", async () => {
    const api = fakeWaveApi();
    const snap = await fetchWaveSnapshot(client(api.fetch), BUSINESS_ID);
    expect(api.calls.filter((c) => c.operation === "Accounts").map((c) => c.variables.archived)).toEqual([false, true]);
    expect(snap.accounts.find((a) => a.name === "Old Printer Lease")?.isArchived).toBe(true);
  });

  it("reads money from minorUnitValue, not the comma-formatted value", async () => {
    const snap = await fetchWaveSnapshot(client(fakeWaveApi().fetch), BUSINESS_ID);
    const inv = snap.invoices.find((i) => i.number === "1002")!;
    expect(inv.total).toBe("1082.50");
    expect(inv.amountDue).toBe("582.50");
    expect(snap.invoices.find((i) => i.number === "1003")!.total).toBe("1960.00");
    expect(snap.accounts.find((a) => a.name === "Business Checking")!.balance).toMatch(/^\d+\.\d\d$/);
  });

  it("decodes each payment's ledger Transaction ID", async () => {
    const snap = await fetchWaveSnapshot(client(fakeWaveApi().fetch), BUSINESS_ID);
    const pays = snap.invoices.find((i) => i.number === "1001")!.payments;
    expect(pays.map((p) => p.ledgerTransactionId)).toEqual([E(7).id, ""]);
    expect(pays[0]!.amount).toBe("500.00");
  });

  it("decodes Wave global IDs the way the live API encodes them", () => {
    const id = btoa("Business:00000000-1111-4222-8333-444444444444;Transaction:1234567890123456789");
    expect(ledgerTransactionId(id)).toBe("1234567890123456789");
    expect(ledgerTransactionId(null)).toBe("");
    expect(ledgerTransactionId("not base64!")).toBe("");
  });

  it("lists businesses and the signed-in user", async () => {
    const c = client(fakeWaveApi().fetch);
    expect(await listBusinesses(c)).toEqual([{ id: BUSINESS_ID, name: "Maple & Pine Design LLC", currency: "USD", isPersonal: false, isArchived: false }]);
    expect((await whoAmI(c)).email).toBe("owner@maple-pine.example");
  });

  it("refuses to send a mutation", async () => {
    await expect(client(fakeWaveApi().fetch).query("mutation { accountArchive(input: {id: \"x\"}) { didSucceed } }")).rejects.toThrow(/read-only/);
  });

  it("backs off and retries when Wave is busy", async () => {
    const api = fakeWaveApi({ failFirst: { status: 429, times: 2 } });
    const waits: number[] = [];
    const c = new WaveClient({ credentials: fullAccessKey("k"), fetch: api.fetch, minIntervalMs: 0, sleep: async (ms) => { waits.push(ms); } });
    expect((await whoAmI(c)).email).toBe("owner@maple-pine.example");
    expect(waits).toEqual([1000, 2000]);
  });

  it("throttles to the configured pace", async () => {
    let now = 0;
    const waits: number[] = [];
    const c = new WaveClient({ credentials: fullAccessKey("k"), fetch: fakeWaveApi().fetch, minIntervalMs: 500, now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } });
    await whoAmI(c);
    await whoAmI(c);
    expect(waits).toEqual([500]);
  });

  it("explains a rejected access key in plain words", async () => {
    const api = fakeWaveApi({ validToken: "right" });
    const err = await whoAmI(client(api.fetch, "wrong")).catch((e) => e);
    expect(err).toBeInstanceOf(InputProblem);
    expect(err.code).toBe("wave-key-rejected");
    expect(err.nextStep).toContain("new key");
  });

  it("refreshes an expired OAuth token once and carries on", async () => {
    const api = fakeWaveApi({ validToken: "fresh" });
    const stored: OAuthTokens[] = [];
    const creds = oauthCredentials({
      tokens: { accessToken: "stale", refreshToken: "r1", expiresAt: Date.now() + 3_600_000 },
      refresher: async (rt) => ({ accessToken: "fresh", refreshToken: `${rt}-next`, expiresAt: Date.now() + 3_600_000 }),
      onTokens: (t) => { stored.push(t); },
    });
    const c = new WaveClient({ credentials: creds, fetch: api.fetch, minIntervalMs: 0, sleep: noSleep });
    expect((await whoAmI(c)).email).toBe("owner@maple-pine.example");
    expect(stored.map((t) => t.refreshToken)).toEqual(["r1-next"]);
  });

  it("refreshes before expiry instead of waiting for a rejection", async () => {
    let refreshed = 0;
    const creds = oauthCredentials({
      tokens: { accessToken: "old", refreshToken: "r", expiresAt: 1_000 },
      refresher: async () => { refreshed++; return { accessToken: "new", refreshToken: "r2", expiresAt: 10_000_000 }; },
      now: () => 990,
    });
    expect(await creds.accessToken()).toBe("new");
    expect(refreshed).toBe(1);
  });

  it("explains Wave's Pro-only rule when an OAuth connection is refused", async () => {
    const api = fakeWaveApi({ failFirst: { status: 403, times: 10 } });
    const creds = oauthCredentials({
      tokens: { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 },
      refresher: async () => { throw new Error("403"); },
    });
    const err = await whoAmI(new WaveClient({ credentials: creds, fetch: api.fetch, minIntervalMs: 0, sleep: noSleep })).catch((e) => e);
    expect(err.code).toBe("wave-access-denied");
    expect(err.explanation).toContain("Pro or Wave Advisor");
  });

  it("builds Wave's authorize URL with read-only scopes", () => {
    const u = new URL(waveAuthorizeUrl({ clientId: "cid", redirectUri: "http://localhost:53682/callback", state: "s1" }));
    expect(u.origin + u.pathname).toBe("https://api.waveapps.com/oauth2/authorize/");
    expect(u.searchParams.get("scope")!.split(" ").every((s) => s.endsWith(":read"))).toBe(true);
    expect(u.searchParams.get("response_type")).toBe("code");
  });

  it("round-trips a snapshot through JSON and refuses unknown formats", async () => {
    const snap = await fetchWaveSnapshot(client(fakeWaveApi().fetch), BUSINESS_ID);
    expect(parseWaveSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
    expect(() => parseWaveSnapshot({ format: "something-else" })).toThrow(InputProblem);
  });
});
