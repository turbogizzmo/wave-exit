import { describe, expect, it } from "vitest";
import { buildBooks, qbo, type Books } from "../src/index.ts";
import { fakeQbo, type FakeQbo } from "./fixtures/fake-qbo.ts";
import { inputs } from "./helpers.ts";

const noSleep = async () => {};

async function books(settings: Partial<Books["settings"]> = {}, connected = true): Promise<Books> {
  const i = await inputs({ connected });
  const draft = buildBooks(i);
  const resolutions = Object.fromEntries(draft.issues.filter((x) => x.severity === "red").map((x) => [x.id, x.options[0]!.value]));
  return buildBooks({ ...i, settings: { resolutions, ...settings } });
}

function client(fake: FakeQbo, maxRetries = 4) {
  return new qbo.QboClient({
    environment: "sandbox", realmId: "9130000000000001", baseUrl: "https://sandbox.test",
    credentials: { accessToken: async () => "tok", refresh: async () => false }, fetch: fake.fetch, sleep: noSleep, maxRetries,
  });
}

async function company(c: qbo.QboClient): Promise<qbo.ExistingCompany> {
  return { accounts: await c.query("Account"), customers: await c.query("Customer"), vendors: await c.query("Vendor"), items: await c.query("Item") };
}

const TXN_TYPES = ["Invoice", "Bill", "Payment", "BillPayment", "Purchase", "Deposit", "SalesReceipt", "Transfer", "CreditCardPayment", "JournalEntry"];
const totalTxns = (f: FakeQbo) => TXN_TYPES.reduce((n, t) => n + f.count(t), 0);

describe("QuickBooks load plan", () => {
  it("carries exactly the ledger, account by account", async () => {
    for (const settings of [{}, { scope: "opening-balances" as const, cutoverDate: "2025-06-30" }]) {
      const b = await books(settings);
      const fake = fakeQbo();
      const co = await company(client(fake));
      const plan = qbo.buildLoadPlan(b, co);
      const preview = qbo.previewPlan(b, plan, co);
      expect(preview.differences, JSON.stringify(settings)).toEqual([]);
    }
  });

  it("uses QuickBooks's own transaction types", async () => {
    const b = await books();
    const plan = qbo.buildLoadPlan(b, await company(client(fakeQbo())));
    const counts = Object.fromEntries(qbo.previewPlan(b, plan, { accounts: [], customers: [], vendors: [], items: [] }).counts.map((c) => [c.entity, c.count]));
    expect(counts).toMatchObject({ Invoice: 5, Bill: 1, Payment: 5, BillPayment: 1, Transfer: 2, CreditCardPayment: 1, SalesReceipt: 1 });
    expect(counts.Purchase).toBeGreaterThanOrEqual(6);
    // The zero-amount entry is left out, with a reason.
    expect(plan.skipped.map((s) => s.why)).toEqual([expect.stringMatching(/no amount/)]);
  });

  it("never lets QuickBooks email historical invoices", async () => {
    const b = await books();
    const plan = qbo.buildLoadPlan(b, await company(client(fakeQbo())));
    for (const op of plan.ops.filter((o) => o.entity === "Invoice")) {
      const body = op.build((k) => `id-${k}`);
      expect(body).toMatchObject({ AllowOnlineCreditCardPayment: false, AllowOnlineACHPayment: false });
    }
  });

  it("matches the golden payloads", async () => {
    const b = await books();
    const plan = qbo.buildLoadPlan(b, await company(client(fakeQbo())));
    const payloads = plan.ops.map((o) => ({ key: o.key, entity: o.entity, phase: o.phase, body: o.build((k) => `<${k}>`) }));
    await expect(JSON.stringify(payloads, null, 2) + "\n").toMatchFileSnapshot("./golden/qbo/payloads.json");
  });

  it("maps onto accounts the company already has", async () => {
    const b = await books();
    const fake = fakeQbo({ accounts: [{ Name: "Business Checking", AccountType: "Bank", AccountSubType: "Checking" }, { Name: "Sales", AccountType: "Expense", AccountSubType: "OtherMiscellaneousServiceCost" }] });
    const co = await company(client(fake));
    const plan = qbo.buildLoadPlan(b, co);
    const checking = b.accounts.find((a) => a.name === "Business Checking")!;
    const sales = b.accounts.find((a) => a.name === "Sales")!;
    expect(plan.mapping.choices.get(checking.id)).toEqual({ kind: "existing", qboId: co.accounts.find((a) => a.Name === "Business Checking")!.Id });
    // Same name but a different kind (expense, not income): created under another name.
    expect(plan.mapping.choices.get(sales.id)).toMatchObject({ kind: "create", name: "Sales (2)" });
    // Overrides from the mapping screen win.
    const forced = qbo.buildLoadPlan(b, co, { accountOverrides: { [checking.id]: "create" } });
    expect(forced.mapping.choices.get(checking.id)).toMatchObject({ kind: "create", name: "Business Checking (2)" });
  });
});

describe("QuickBooks direct load", () => {
  it("loads everything and QuickBooks's trial balance and aging match (check 8)", async () => {
    const b = await books();
    const fake = fakeQbo();
    const c = client(fake);
    const plan = qbo.buildLoadPlan(b, await company(c));
    const record = qbo.newLoadRecord("sandbox", c.realmId, "Sandbox Company");
    const saves: string[] = [];
    await qbo.runLoad(plan, c, record, { save: (r) => void saves.push(r.status) });
    expect(record.failed).toEqual([]);
    expect(record.status).toBe("finished");
    expect(record.created).toHaveLength(plan.ops.length);
    expect(saves.at(-1)).toBe("finished");
    const check = await qbo.verifyLoad(b, plan, record, c);
    expect(check.details).toEqual([]);
    expect(check.status).toBe("green");
    // Every write carried a request ID.
    expect(fake.requests.filter((r) => r.method === "POST").every((r) => r.requestId?.startsWith("we") && r.requestId.length <= 36)).toBe(true);
  });

  it("resumes after the app dies mid-load without creating anything twice", async () => {
    const b = await books();
    const fake = fakeQbo({ dieAfterBatches: 4 }); // QuickBooks saved batch 4, the app never heard back
    const c = client(fake, 0);
    const plan = qbo.buildLoadPlan(b, await company(c));
    let saved = qbo.newLoadRecord("sandbox", c.realmId, "Sandbox Company");
    const persist = (r: qbo.LoadRecord) => void (saved = structuredClone(r));
    await qbo.runLoad(plan, c, saved, { save: persist });
    expect(saved.status).toBe("failed");
    const before = saved.created.length;
    // Start again from the saved record, as the app would after a restart.
    const resumed = structuredClone(saved);
    await qbo.runLoad(plan, client(fake), resumed, { save: persist });
    expect(resumed.status).toBe("finished");
    expect(resumed.created.length).toBe(plan.ops.length);
    expect(before).toBeLessThan(plan.ops.length);
    expect(totalTxns(fake)).toBe(plan.ops.filter((o) => TXN_TYPES.includes(o.entity)).length);
    expect((await qbo.verifyLoad(b, plan, resumed, client(fake))).status).toBe("green");
  });

  it("can pause and continue", async () => {
    const b = await books();
    const fake = fakeQbo();
    const c = client(fake);
    const plan = qbo.buildLoadPlan(b, await company(c));
    const record = qbo.newLoadRecord("sandbox", c.realmId, "Sandbox Company");
    const ctl = new AbortController();
    await qbo.runLoad(plan, c, record, { save: () => {}, onProgress: (p) => { if (p.done > 10) ctl.abort(); }, signal: ctl.signal });
    expect(record.status).toBe("paused");
    await qbo.runLoad(plan, c, record, { save: () => {} });
    expect(record.status).toBe("finished");
    expect(totalTxns(fake)).toBe(plan.ops.filter((o) => TXN_TYPES.includes(o.entity)).length);
  });

  it("running twice creates nothing the second time", async () => {
    const b = await books();
    const fake = fakeQbo();
    const c = client(fake);
    const plan = qbo.buildLoadPlan(b, await company(c));
    const record = qbo.newLoadRecord("sandbox", c.realmId, "Sandbox Company");
    await qbo.runLoad(plan, c, record, { save: () => {} });
    const posts = fake.requests.filter((r) => r.method === "POST").length;
    await qbo.runLoad(plan, c, record, { save: () => {} });
    expect(fake.requests.filter((r) => r.method === "POST").length).toBe(posts);
    expect(record.created.length).toBe(plan.ops.length);
  });

  it("undo removes everything it loaded and the company is empty again", async () => {
    const b = await books();
    const fake = fakeQbo();
    const c = client(fake);
    const plan = qbo.buildLoadPlan(b, await company(c));
    const record = qbo.newLoadRecord("sandbox", c.realmId, "Sandbox Company");
    await qbo.runLoad(plan, c, record, { save: () => {} });
    await qbo.undoLoad(c, record, { save: () => {} });
    expect(record.failed).toEqual([]);
    expect(record.status).toBe("undone");
    expect(record.created).toEqual([]);
    expect(totalTxns(fake)).toBe(0);
    for (const e of ["Account", "Customer", "Vendor", "Item"]) expect(fake.count(e, true), e).toBe(0);
    // Loading again after an undo uses new request IDs, so nothing old is replayed.
    expect(record.generation).toBe(2);
    const again = qbo.buildLoadPlan(b, await company(c));
    await qbo.runLoad(again, c, record, { save: () => {} });
    expect(record.failed.map((f) => `${f.label}: ${f.explanation}`)).toEqual([]);
    expect(record.status).toBe("finished");
  });

  it("undo leaves records changed in QuickBooks since, and says so", async () => {
    const b = await books();
    const fake = fakeQbo();
    const c = client(fake);
    const plan = qbo.buildLoadPlan(b, await company(c));
    const record = qbo.newLoadRecord("sandbox", c.realmId, "Sandbox Company");
    await qbo.runLoad(plan, c, record, { save: () => {} });
    const someone = record.created.find((x) => x.entity === "JournalEntry")!;
    fake.store.get("JournalEntry")!.get(someone.id)!.SyncToken = "3";
    await qbo.undoLoad(c, record, { save: () => {} });
    expect(record.failed.map((f) => f.key)).toContain(someone.key);
    expect(record.failed[0]!.explanation).toMatch(/changed in QuickBooks/);
  });

  it("refuses to use a record from another company", async () => {
    const b = await books();
    const c = client(fakeQbo());
    const plan = qbo.buildLoadPlan(b, await company(c));
    await expect(qbo.runLoad(plan, c, qbo.newLoadRecord("sandbox", "other-realm", "X"), { save: () => {} })).rejects.toThrow(/another company/);
  });

  it("export-file-only books load too", async () => {
    const b = await books({}, false);
    const fake = fakeQbo();
    const c = client(fake);
    const plan = qbo.buildLoadPlan(b, await company(c));
    const record = qbo.newLoadRecord("sandbox", c.realmId, "Sandbox Company");
    await qbo.runLoad(plan, c, record, { save: () => {} });
    expect(record.failed).toEqual([]);
    expect((await qbo.verifyLoad(b, plan, record, c)).status).toBe("green");
  });

  it("opening-balances scope loads and ties out", async () => {
    const b = await books({ scope: "opening-balances", cutoverDate: "2025-06-30" });
    const fake = fakeQbo();
    const c = client(fake);
    const plan = qbo.buildLoadPlan(b, await company(c));
    const record = qbo.newLoadRecord("sandbox", c.realmId, "Sandbox Company");
    await qbo.runLoad(plan, c, record, { save: () => {} });
    expect(record.failed).toEqual([]);
    expect((await qbo.verifyLoad(b, plan, record, c)).details).toEqual([]);
  });
});

describe("QuickBooks client and sign-in", () => {
  it("waits 60 seconds after a 429, as Intuit asks", async () => {
    const waits: number[] = [];
    let n = 0;
    const c = new qbo.QboClient({
      environment: "sandbox", realmId: "1", baseUrl: "https://x.test", credentials: { accessToken: async () => "t", refresh: async () => false },
      sleep: async (ms) => void waits.push(ms),
      fetch: async () => (++n === 1 ? { status: 429, headers: { get: () => null }, text: async () => "" } : { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ QueryResponse: { Account: [] } }) }),
    });
    await c.query("Account");
    expect(waits).toContain(60_000);
  });

  it("explains QuickBooks faults in plain words", () => {
    const e = new qbo.QboError(400, { type: "ValidationFault", errors: [{ message: "Duplicate Name Exists Error", detail: "The name supplied already exists. : Sales", code: "6240" }] });
    expect(qbo.explainQboError(e).explanation).toMatch(/already has something with the same name/);
  });

  it("builds Intuit's sign-in URL and checks the reply", () => {
    const u = new URL(qbo.intuitAuthorizeUrl({ clientId: "abc", redirectUri: "http://localhost:53682/callback", state: "s1" }));
    expect(u.origin + u.pathname).toBe("https://appcenter.intuit.com/connect/oauth2");
    expect(u.searchParams.get("scope")).toBe("com.intuit.quickbooks.accounting");
    expect(qbo.parseIntuitRedirect("http://localhost:53682/callback?code=c1&state=s1&realmId=42", "s1")).toEqual({ code: "c1", realmId: "42" });
    expect(() => qbo.parseIntuitRedirect("http://localhost/cb?code=c1&state=evil&realmId=42", "s1")).toThrow(/didn't match/);
    expect(() => qbo.parseIntuitRedirect("http://localhost/cb?error=access_denied&state=s1", "s1")).toThrow(/cancelled/);
  });

  it("refreshes the access token before it runs out and stores the new one", async () => {
    const stored: string[] = [];
    let t = 1_000_000;
    const creds = qbo.intuitCredentials({
      tokens: { accessToken: "a1", refreshToken: "r1", expiresAt: t + 60_000, refreshExpiresAt: t + 8_640_000_000 },
      exchanger: { exchangeCode: async () => { throw new Error("unused"); }, refresh: async (r) => ({ accessToken: "a2", refreshToken: `${r}x`, expiresAt: t + 3_600_000, refreshExpiresAt: t + 8_640_000_000 }) },
      onTokens: (x) => void stored.push(x.refreshToken),
      now: () => t,
    });
    expect(await creds.accessToken()).toBe("a2"); // within 2 minutes of expiry: refreshed first
    expect(stored).toEqual(["r1x"]);
    t += 60_000;
    expect(await creds.accessToken()).toBe("a2");
  });
});
