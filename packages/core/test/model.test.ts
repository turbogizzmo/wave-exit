import { describe, expect, it } from "vitest";
import { blockingItems, buildBooks, formatPlain, trialBalance, type Books } from "../src/index.ts";
import { ACCOUNTS, E, ENTRIES, VENDORS } from "./fixtures/synthetic.ts";
import { books, inputs } from "./helpers.ts";

const waveId = (key: string) => ACCOUNTS.find((a) => a.key === key)!.waveId;
const entry = (b: Books, n: number) => b.entries.find((e) => e.id === E(n).id)!;
const issue = (b: Books, kind: string) => b.issues.filter((i) => i.kind === kind);
const money = (b: Books, v: bigint) => formatPlain(v, b.business.exponent);

describe("chart of accounts", () => {
  it("uses Wave's full chart, merging identical system accounts", async () => {
    const b = await books();
    const ar = b.accounts.find((a) => a.subtype === "RECEIVABLE_INVOICES")!;
    expect(ar.waveIds.sort()).toEqual([waveId("ar1"), waveId("ar2"), waveId("ar3")].sort());
    expect(b.accounts.filter((a) => a.name === "Transfer Clearing")).toHaveLength(1);
    expect(b.accounts.find((a) => a.name === "Transfer Clearing")!.waveIds).toHaveLength(4);
    // System Receivable Non-Invoice is a different subtype: kept apart.
    expect(b.accounts.some((a) => a.subtype === "RECEIVABLE_OTHER")).toBe(true);
    // Accounts with no activity are still in the chart.
    expect(b.accounts.find((a) => a.name === "Vehicle Loan")?.lineCount).toBe(0);
  });

  it("keeps archived accounts that carry history, flagged inactive", async () => {
    const b = await books();
    const lease = b.accounts.find((a) => a.name === "Old Printer Lease")!;
    expect(lease.isArchived).toBe(true);
    expect(lease.lineCount).toBe(1);
  });

  it("picks the one user duplicate with a balance, without asking", async () => {
    const b = await books();
    const used = b.accounts.filter((a) => a.name === "Office Supplies");
    expect(used).toHaveLength(2);
    expect(used.find((a) => a.lineCount > 0)!.id).toBe(`wave:${waveId("office")}`);
  });

  it("asks when user duplicates can't be told apart, and applies the answer", async () => {
    const b = await books();
    const [card] = issue(b, "ambiguous-account");
    expect(card).toMatchObject({ severity: "red", title: '2 accounts are named "Software"' });
    expect(card!.options).toHaveLength(2);
    expect(blockingItems(b).issues.map((i) => i.id)).toContain(card!.id);

    const answered = await books({ settings: { resolutions: { [card!.id]: waveId("softwareDup") } } });
    expect(issue(answered, "ambiguous-account")).toHaveLength(0);
    expect(answered.accounts.find((a) => a.id === `wave:${waveId("softwareDup")}`)!.lineCount).toBe(2);
  });

  it("infers the chart from the export when there is no connection", async () => {
    const b = await books({ connected: false });
    expect(b.mode).toBe("export-file-only");
    expect(b.accounts.every((a) => a.id.startsWith("export:"))).toBe(true);
    expect(b.accounts.find((a) => a.name === "Business Checking")!.role).toBe("bank");
    expect(b.accounts.find((a) => a.name === "Accounts Payable")!.role).toBe("payable");
    expect(b.accounts.some((a) => a.name === "Vehicle Loan")).toBe(false);
  });
});

describe("classification", () => {
  it("classifies every fixture entry as expected", async () => {
    const b = await books();
    const expected: Record<number, string> = {
      1: "journal", 2: "expense", 3: "expense", 4: "refund", 5: "expense", 6: "invoice", 7: "invoice-payment", 8: "invoice-payment",
      9: "invoice", 10: "invoice-payment", 11: "invoice", 12: "invoice", 13: "invoice-payment", 14: "invoice", 15: "invoice-payment",
      16: "transfer", 17: "transfer", 18: "transfer", 19: "credit-card-payment", 20: "credit-card-payment", 21: "journal",
      22: "sales-receipt", 23: "deposit", 24: "bill", 25: "bill-payment", 26: "expense", 27: "journal", 28: "journal",
      29: "refund", 30: "expense", 31: "expense", 32: "journal", 33: "journal",
    };
    const got = Object.fromEntries(ENTRIES.map((_, i) => [i + 1, entry(b, i + 1).type]));
    expect(got).toEqual(expected);
    expect(entry(b, 26).lines).toHaveLength(21);
    expect(entry(b, 32).ruleId).toBe("zero-amount");
    expect(b.entries.every((e) => e.why.length > 20)).toBe(true);
  });

  it("pairs transfer legs through Transfer Clearing, including a next-day card payment", async () => {
    const b = await books();
    expect(entry(b, 17).pairedWith).toBe(E(18).id);
    expect(entry(b, 18).pairedWith).toBe(E(17).id);
    expect(entry(b, 19).pairedWith).toBe(E(20).id);
    const [card] = issue(b, "unpaired-transfer");
    expect(card!.refs).toEqual([E(21).id]);
    expect(card!.severity).toBe("amber");
  });

  it("lets the user pair a leg by hand", async () => {
    const extra = { ...E(18), id: "9999999999999999999", date: "2025-06-10", description: "TRANSFER IN 5521", lines: [{ account: "savings", debit: "99.00" }, { account: "tc", credit: "99.00" }] };
    const b = await books({ entries: [...ENTRIES, extra], settings: { resolutions: { [`unpaired-transfer:${E(21).id}`]: extra.id } } });
    expect(entry(b, 21).type).toBe("transfer");
    expect(entry(b, 21).pairedWith).toBe(extra.id);
  });

  it("uses an edited rules table", async () => {
    const i = await inputs();
    const base = buildBooks(i);
    const rules = base.rules.map((r) => (r.id === "refund" ? { ...r, enabled: false } : r));
    const b = buildBooks({ ...i, settings: { rules } });
    expect(entry(b, 4).type).toBe("journal");
  });
});

describe("open items", () => {
  it("links payments by Wave's Transaction ID, else by number + date + amount", async () => {
    const b = await books();
    const inv1001 = b.invoices.find((d) => d.number === "1001")!;
    expect(inv1001.payments.map((p) => [p.entryId, p.linkedBy])).toEqual([[E(7).id, "wave-id"], [E(8).id, "invoice-date-amount"]]);
    expect(inv1001.status).toBe("paid");
  });

  it("splits one deposit across two invoices", async () => {
    const b = await books();
    const apps = b.payments.filter((p) => p.entryId === E(13).id);
    expect(apps.map((p) => [p.appliedToNumber, money(b, p.appliedAmount), money(b, p.amount)])).toEqual([["1003", "1960.00", "2710.00"], ["1004", "750.00", "2710.00"]]);
  });

  it("works out what is still owed and agrees with Wave", async () => {
    const b = await books();
    const by = Object.fromEntries(b.invoices.map((d) => [d.number, [d.status, money(b, d.amountDue)]]));
    expect(by).toEqual({ "1001": ["paid", "0.00"], "1002": ["partial", "582.50"], "1003": ["paid", "0.00"], "1004": ["paid", "0.00"], "1005": ["paid", "0.00"] });
    expect(issue(b, "invoice-mismatch")).toHaveLength(0);
    // The fee doesn't reduce what the customer paid.
    expect(money(b, b.payments.find((p) => p.entryId === E(15).id)!.appliedAmount)).toBe("900.00");
  });

  it("raises a card when an invoice's payments don't add up to what Wave says", async () => {
    const i = await inputs();
    const wave = structuredClone(i.wave!);
    wave.invoices.find((x) => x.number === "1002")!.amountDue = "482.50";
    const b = buildBooks({ ...i, wave });
    const [card] = issue(b, "invoice-mismatch");
    expect(card!.explanation).toContain("482.50");
    expect(b.checks.find((c) => c.id === 4)!.status).toBe("amber");
  });

  it("lists receivable credits that name no invoice instead of dropping them", async () => {
    const b = await books();
    const [card] = issue(b, "unlinked-receivable");
    expect(card!.refs).toEqual([E(28).id]);
    const c4 = b.checks.find((c) => c.id === 4)!;
    expect(c4.status).toBe("amber");
    expect(c4.details.join("\n")).toContain("Difference -50.00");
  });

  it("builds bills and their payments from the ledger", async () => {
    const b = await books();
    expect(b.bills.map((d) => [d.number, d.contactId, money(b, d.total), money(b, d.amountDue), d.status])).toEqual([
      ["B-77", `wave:${VENDORS[2]!.waveId}`, "600.00", "200.00", "partial"],
    ]);
    expect(b.checks.find((c) => c.id === 5)!.status).toBe("green");
  });

  it("ages open items at the cutover date, payments after it not counted", async () => {
    const b = await books({ settings: { cutoverDate: "2025-03-05" } });
    const rows = Object.fromEntries(b.agingAr.map((r) => [r.number, [money(b, r.amountDue), r.bucket, r.daysPastDue]]));
    // 1001 due 2025-03-03 with 500 paid; the 1000 payment on 03-01 counts. 1002 is not yet due.
    expect(rows).toEqual({ "1002": ["1082.50", "current", 0] });
    const later = await books({ settings: { cutoverDate: "2025-06-30" } });
    expect(later.agingAr.map((r) => [r.number, r.bucket])).toEqual([["1002", "90+"]]);
  });

  it("rebuilds invoices from the ledger when there is no connection", async () => {
    const b = await books({ connected: false });
    expect(b.invoices.map((d) => d.number)).toEqual(["1001", "1002", "1003", "1004", "1005"]);
    expect(b.invoices.every((d) => !d.dueDateKnown && d.payments.every((p) => p.linkedBy === "ledger-number"))).toBe(true);
    expect(money(b, b.invoices.find((d) => d.number === "1002")!.amountDue)).toBe("582.50");
  });
});

describe("receipts", () => {
  it("links unique matches and asks about the rest", async () => {
    const b = await books();
    expect(b.receipts.map((r) => r.status)).toEqual(["linked", "ambiguous", "unmatched"]);
    expect(entry(b, 2).attachments).toEqual(["2025-01-05-PAPER_PLANET_#221.pdf"]);
    const amb = issue(b, "receipt-ambiguous")[0]!;
    expect(amb.refs.sort()).toEqual([E(30).id, E(31).id].sort());
    const answered = await books({ settings: { resolutions: { [amb.id]: E(31).id } } });
    expect(entry(answered, 31).attachments).toEqual(["2025-09-12-CORNER_COFFEE.jpg"]);
  });
});

describe("tie-out checks", () => {
  it("are green or explained on the fixture business", async () => {
    const b = await books();
    expect(Object.fromEntries(b.checks.map((c) => [c.id, c.status]))).toEqual({ 1: "green", 2: "green", 3: "green", 4: "amber", 5: "green", 6: "green", 7: "green" });
  });

  it("check 3 catches transactions added in Wave after the export, and can be accepted", async () => {
    const b = await books({ api: { balanceOverrides: { checking: "1.00" } } });
    const c3 = b.checks.find((c) => c.id === 3)!;
    expect(c3.status).toBe("red");
    expect(c3.details[0]).toMatch(/^Business Checking: export [\d.]+, Wave 1\.00/);
    const card = issue(b, "balance-difference")[0]!;
    expect(card.explanation).toContain("newest change in this export is dated 2025-12-31");
    const accepted = await books({ api: { balanceOverrides: { checking: "1.00" } }, settings: { resolutions: { "balance-difference": "accept" } } });
    expect(accepted.checks.find((c) => c.id === 3)!.status).toBe("amber");
    expect(blockingItems(accepted).checks).toHaveLength(0);
  });

  it("check 3 is skipped without a connection", async () => {
    const b = await books({ connected: false });
    expect(b.checks.find((c) => c.id === 3)!.status).toBe("skipped");
  });

  it("check 6 counts every line, contact and receipt in", async () => {
    const b = await books();
    const lines = ENTRIES.reduce((n, e) => n + e.lines.length, 0);
    expect(b.checks.find((c) => c.id === 6)!.summary).toBe(`All ${lines} ledger lines, 8 contacts and 3 receipts were read.`);
  });

  it("check 7 flags entries dated after the export", async () => {
    const late = { ...E(2), id: "9999999999999999998", date: "2026-02-01" };
    const b = await books({ entries: [...ENTRIES, late] });
    expect(b.checks.find((c) => c.id === 7)!.status).toBe("amber");
  });

  it("spots an export from a different business", async () => {
    const i = await inputs();
    const wave = structuredClone(i.wave!);
    wave.customers = wave.customers.map((c, n) => ({ ...c, name: `Other Customer ${n}` }));
    wave.vendors = wave.vendors.map((v, n) => ({ ...v, name: `Other Vendor ${n}` }));
    const b = buildBooks({ ...i, wave });
    expect(issue(b, "wrong-business")[0]?.severity).toBe("red");
  });

  it("ties the trial balance to Wave's balances account by account", async () => {
    const b = await books();
    const tb = new Map(trialBalance(b.entries, b.accounts).map((r) => [r.accountId, r.balance]));
    for (const a of b.accounts) expect(tb.get(a.id)).toBe(a.waveBalance);
  });
});

describe("determinism", () => {
  it("gives the same model for the same inputs", async () => {
    const i = await inputs();
    expect(buildBooks(i)).toEqual(buildBooks(i));
  });
});
