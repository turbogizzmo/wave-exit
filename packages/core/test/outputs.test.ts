import { parse } from "csv-parse/sync";
import fc from "fast-check";
import { strFromU8, unzipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  APP_VERSION, balanceSheet, buildBooks, createOutputs, fiscalYears, glRows, OPENING_ENTRY_ID, OUTPUTS, OutputsBlocked,
  profitAndLoss, readTransactionsExport, readUniversalPackage, renderText, reportPack, scopedLedger, sum, tieOutReport,
  trialBalance, writeUniversalPackage, type Aspect, type Books, type OutputContext, type OutputFile,
} from "../src/index.ts";
import { ENTRIES, transactionsZip, type FxEntry } from "./fixtures/synthetic.ts";
import { inputs } from "./helpers.ts";

const CREATED = new Date("2026-01-20T10:00:00Z");
const GOLDEN = "./golden";

async function fixtureBooks(opts: Parameters<typeof inputs>[0] & { scope?: Books["settings"]["scope"]; cutoverDate?: string } = {}) {
  const i = await inputs(opts);
  const draft = buildBooks(i);
  // Answer the one red card so outputs are allowed.
  const resolutions = Object.fromEntries(draft.issues.filter((x) => x.severity === "red").map((x) => [x.id, x.options[0]!.value]));
  const books = buildBooks({ ...i, settings: { resolutions, ...(opts.scope ? { scope: opts.scope } : {}), ...(opts.cutoverDate ? { cutoverDate: opts.cutoverDate } : {}) } });
  const ctx: OutputContext = { createdAt: CREATED, appVersion: APP_VERSION, attachments: new Map((i.receipts?.receipts ?? []).map((r) => [r.fileName, r.data])) };
  return { books, ctx };
}

const csv = (bytes: Uint8Array) => parse(strFromU8(bytes), { bom: true, columns: true }) as Record<string, string>[];

describe("output catalog", () => {
  it("always adds the universal package", async () => {
    const { books, ctx } = await fixtureBooks();
    const res = await createOutputs(books, ["gl-csv"], ctx);
    expect(res.map((r) => r.plugin.id)).toEqual(["universal-package", "gl-csv"]);
  });

  it("refuses while Review has red items", async () => {
    const i = await inputs();
    const books = buildBooks(i); // the ambiguous "Software" card is unanswered
    await expect(createOutputs(books, ["excel"], { createdAt: CREATED, appVersion: APP_VERSION, attachments: new Map() })).rejects.toBeInstanceOf(OutputsBlocked);
  });

  it("every card states what it keeps and loses, and never claims both", async () => {
    const { books } = await fixtureBooks();
    for (const p of OUTPUTS) {
      const d = p.describe(books);
      expect(d.keeps.length, p.id).toBeGreaterThan(0);
      const both = d.keeps.filter((k) => d.loses.some((l) => l.aspect === k.aspect));
      expect(both, p.id).toEqual([]);
    }
  });
});

/** What a set of output files actually contains, looked at from outside. */
function aspectsIn(id: string, files: OutputFile[]): Set<Aspect> {
  const has = new Set<Aspect>();
  const f = files[0]!;
  if (id === "universal-package") {
    const z = unzipSync(f.bytes);
    const map: [string, Aspect][] = [
      ["journal.csv", "ledger"], ["accounts.csv", "chart-of-accounts"], ["contacts.csv", "contacts"], ["invoices.csv", "invoices"],
      ["invoice_lines.csv", "invoice-lines"], ["bills.csv", "bills"], ["payments.csv", "payments"], ["items.csv", "items"],
      ["tax_rates.csv", "tax-rates"], ["estimates.csv", "estimates"], ["trial_balance.csv", "trial-balance"], ["aging_ar.csv", "aging"],
      ["tie_out_report.pdf", "tie-out"], ["review_items.csv", "review-answers"],
    ];
    for (const [file, a] of map) if (z[file]) has.add(a);
    if (csv(z["journal.csv"]!).every((r) => r.entry_type)) has.add("entry-types");
    if (Object.keys(csv(z["contacts.csv"]!)[0]!).includes("address_line_1")) has.add("contact-details");
    if (Object.keys(z).some((k) => k.startsWith("attachments/") && k !== "attachments.csv")) has.add("attachments");
    if (/[0-9a-f]{64}/.test(strFromU8(z["manifest.json"]!))) has.add("source-checksums");
  } else if (id === "gl-csv") {
    const rows = csv(f.bytes);
    has.add("ledger");
    if (rows.every((r) => r.entry_type)) has.add("entry-types");
    if (rows.every((r) => r.account_code && r.account_type)) has.add("chart-of-accounts");
  } else if (id === "excel") {
    const z = unzipSync(f.bytes);
    const names = [...strFromU8(z["xl/workbook.xml"]!).matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]!);
    const map: [string, Aspect][] = [
      ["Journal", "ledger"], ["Accounts", "chart-of-accounts"], ["Contacts", "contacts"], ["Invoices", "invoices"], ["Invoice Lines", "invoice-lines"],
      ["Bills", "bills"], ["Payments", "payments"], ["Items", "items"], ["Tax Rates", "tax-rates"], ["Estimates", "estimates"],
      ["Trial Balance", "trial-balance"], ["AR Aging", "aging"], ["Review Items", "review-answers"],
    ];
    for (const [s, a] of map) if (names.includes(s)) has.add(a);
    const journal = strFromU8(z[`xl/worksheets/sheet${names.indexOf("Journal") + 1}.xml`]!);
    if (journal.includes("entry_type")) has.add("entry-types");
    if (strFromU8(z[`xl/worksheets/sheet${names.indexOf("Contacts") + 1}.xml`]!).includes("address_line_1")) has.add("contact-details");
    if (Object.keys(z).some((k) => !k.endsWith(".xml") && !k.endsWith(".rels"))) has.add("attachments");
  }
  return has;
}

describe("keeps / loses statements match what is produced", () => {
  for (const id of ["universal-package", "gl-csv", "excel"]) {
    it(id, async () => {
      const { books, ctx } = await fixtureBooks();
      const p = OUTPUTS.find((x) => x.id === id)!;
      const files = await p.produce(books, ctx);
      const present = aspectsIn(id, files);
      const d = p.describe(books);
      expect(d.keeps.map((k) => k.aspect).filter((a) => !present.has(a)), "claimed kept but missing").toEqual([]);
      expect(d.loses.map((l) => l.aspect).filter((a) => present.has(a)), "claimed lost but present").toEqual([]);
    });
  }

  it("pdf-pack", async () => {
    const { books, ctx } = await fixtureBooks();
    const text = renderText(reportPack(books, ctx.createdAt));
    const probes: Partial<Record<Aspect, RegExp>> = {
      "tie-out": /Tie-out summary/, "trial-balance": /## Trial balance at/, "yearly-statements": /## Profit and loss: 2025[\s\S]*## Balance sheet at/,
      aging: /## Accounts receivable aging/, ledger: /## General ledger:/, "review-answers": /## Review items/, "source-checksums": /[0-9a-f]{64}/,
      "invoice-lines": /Brand workshop.*125/, attachments: /PAPER_PLANET/,
    };
    const d = OUTPUTS.find((x) => x.id === "pdf-pack")!.describe(books);
    for (const k of d.keeps) expect(probes[k.aspect]!.test(text), k.aspect).toBe(true);
    for (const l of d.loses) if (probes[l.aspect]) expect(probes[l.aspect]!.test(text), l.aspect).toBe(false);
  });
});

describe("universal package", () => {
  it("matches the golden files", async () => {
    const { books, ctx } = await fixtureBooks();
    const [file] = await (OUTPUTS[0]!).produce(books, ctx);
    expect(file!.name).toBe("Maple & Pine Design LLC – Wave export – 2026-01-20.zip");
    const z = unzipSync(file!.bytes);
    expect(Object.keys(z)).toEqual([
      "manifest.json", "accounts.csv", "contacts.csv", "items.csv", "tax_rates.csv", "journal.csv", "invoices.csv", "invoice_lines.csv",
      "bills.csv", "bill_lines.csv", "payments.csv", "estimates.csv", "estimate_lines.csv", "trial_balance.csv", "aging_ar.csv", "aging_ap.csv",
      "attachments.csv", "review_items.csv",
      "attachments/2025-01-05-PAPER_PLANET_#221.pdf", "attachments/2025-09-12-CORNER_COFFEE.jpg", "attachments/2025-09-30-UNKNOWN_SHOP.png",
      "tie_out_report.pdf", "README.html",
    ]);
    for (const [name, bytes] of Object.entries(z)) {
      if (name.startsWith("attachments/") || name.endsWith(".pdf")) continue;
      await expect(strFromU8(bytes)).toMatchFileSnapshot(`${GOLDEN}/universal-package/${name}`);
    }
    await expect(renderText(tieOutReport(books, CREATED))).toMatchFileSnapshot(`${GOLDEN}/universal-package/tie_out_report.txt`);
  });

  it("writes UTF-8 with a BOM, CRLF, ISO dates and plain two-place amounts", async () => {
    const { books, ctx } = await fixtureBooks();
    const z = unzipSync(await writeUniversalPackage(books, ctx));
    const j = z["journal.csv"]!;
    expect([...j.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(strFromU8(j)).toContain("\r\n");
    const rows = csv(j);
    expect(rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date!) && /^\d+\.\d{2}$/.test(r.debit!) && /^\d+\.\d{2}$/.test(r.credit!))).toBe(true);
    // Debits equal credits per entry and overall.
    const byEntry = new Map<string, bigint>();
    for (const r of rows) byEntry.set(r.entry_id!, (byEntry.get(r.entry_id!) ?? 0n) + BigInt(r.debit!.replace(".", "")) - BigInt(r.credit!.replace(".", "")));
    expect([...byEntry.values()].every((v) => v === 0n)).toBe(true);
  });

  it("round-trips: package → books → package is byte-for-byte identical", async () => {
    for (const opts of [{}, { connected: false }, { scope: "opening-balances" as const, cutoverDate: "2025-06-30" }]) {
      const { books, ctx } = await fixtureBooks(opts);
      const pkg = await writeUniversalPackage(books, ctx);
      const back = readUniversalPackage(pkg);
      const again = await writeUniversalPackage(back.books, { ...ctx, attachments: back.attachments });
      expect(Buffer.compare(Buffer.from(pkg), Buffer.from(again)), JSON.stringify(opts)).toBe(0);
    }
  });

  it("round-trips any balanced ledger", async () => {
    const keys = ["checking", "savings", "visa", "office", "sales", "owner", "equipment", "meals"];
    const entry = fc.record({
      day: fc.integer({ min: 0, max: 700 }),
      amounts: fc.array(fc.integer({ min: 1, max: 9_999_999 }), { minLength: 1, maxLength: 6 }),
      accounts: fc.array(fc.constantFrom(...keys), { minLength: 7, maxLength: 7 }),
      description: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim() !== "" && !/[\r\n]/.test(s)),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(entry, { minLength: 1, maxLength: 15 }), async (raw) => {
        const entries: FxEntry[] = raw.map((e, i) => {
          const total = e.amounts.reduce((s, a) => s + a, 0);
          const c = (n: number) => (n / 100).toFixed(2);
          return {
            id: `7${String(i).padStart(18, "0")}`, date: new Date(Date.UTC(2024, 0, 1) + e.day * 86_400_000).toISOString().slice(0, 10), description: e.description,
            lines: [...e.amounts.map((a, k) => ({ account: e.accounts[k]!, debit: c(a) })), { account: e.accounts[6]!, credit: c(total) }],
          };
        });
        const tx = await readTransactionsExport([{ path: "x.zip", bytes: transactionsZip({ entries }) }]);
        const books = buildBooks({ transactions: tx, business: { name: "Prop Co", currency: "USD" } });
        const ctx: OutputContext = { createdAt: CREATED, appVersion: APP_VERSION, attachments: new Map() };
        const pkg = await writeUniversalPackage(books, ctx);
        const again = await writeUniversalPackage(readUniversalPackage(pkg).books, ctx);
        expect(Buffer.compare(Buffer.from(pkg), Buffer.from(again))).toBe(0);
      }),
      { numRuns: 25 },
    );
  });

  it("export-file-only mode still produces every file, with the losses recorded", async () => {
    const { books, ctx } = await fixtureBooks({ connected: false });
    const z = unzipSync(await writeUniversalPackage(books, ctx));
    const m = JSON.parse(strFromU8(z["manifest.json"]!));
    expect(m.input_mode).toBe("export-file-only");
    expect(csv(z["items.csv"]!)).toEqual([]);
    expect(csv(z["invoices.csv"]!).every((r) => r.lines_from === "ledger" && r.due_date_known === "false")).toBe(true);
    expect(strFromU8(z["README.html"]!)).toContain("without a Wave connection");
  });
});

describe("general ledger CSV", () => {
  it("matches the golden file (full history)", async () => {
    const { books, ctx } = await fixtureBooks();
    const [f] = await OUTPUTS.find((p) => p.id === "gl-csv")!.produce(books, ctx);
    await expect(strFromU8(f!.bytes)).toMatchFileSnapshot(`${GOLDEN}/gl-csv/general-ledger.csv`);
    expect(csv(f!.bytes)).toHaveLength(ENTRIES.reduce((n, e) => n + e.lines.length, 0));
  });

  it("matches the golden file (opening balances at 2025-06-30)", async () => {
    const { books, ctx } = await fixtureBooks({ scope: "opening-balances", cutoverDate: "2025-06-30" });
    const [f] = await OUTPUTS.find((p) => p.id === "gl-csv")!.produce(books, ctx);
    await expect(strFromU8(f!.bytes)).toMatchFileSnapshot(`${GOLDEN}/gl-csv/opening-balances.csv`);
  });
});

describe("opening balances", () => {
  it("balance, leave AR/AP to the open documents, and reproduce the end-date balances", async () => {
    const { books } = await fixtureBooks({ scope: "opening-balances", cutoverDate: "2025-06-30" });
    const scoped = scopedLedger(books);
    const opening = scoped.entries[0]!;
    expect(opening.id).toBe(OPENING_ENTRY_ID);
    expect(opening.debitTotal).toBe(opening.creditTotal);
    expect(scoped.entries.slice(1).every((e) => e.date > "2025-06-30")).toBe(true);

    const all = [...books.accounts, ...scoped.extraAccounts];
    const full = new Map(trialBalance(books.entries, books.accounts).map((r) => [r.accountId, r.balance] as const));
    const fromOpening = new Map(trialBalance(scoped.entries, all).map((r) => [r.accountId, r.balance] as const));
    const role = new Map(all.map((a) => [a.id, a] as const));
    for (const a of books.accounts) {
      if (a.role === "receivable" || a.role === "payable") continue;
      expect(fromOpening.get(a.id), a.name).toBe(full.get(a.id));
    }
    // The left-out AR/AP sits in Opening Balance Equity, equal to the open documents at cutover.
    const obe = fromOpening.get("wave-exit:opening-balance-equity")!;
    const openAr = sum(books.agingAr.map((r) => r.amountDue));
    const openAp = sum(books.agingAp.map((r) => r.amountDue));
    const arAtCut = sum(trialBalance(books.entries, books.accounts, "2025-06-30").filter((r) => role.get(r.accountId)!.role === "receivable").map((r) => r.balance));
    expect(-obe).toBe(arAtCut - openAp); // credit-normal equity, debit-positive AR
    expect(openAr).toBeGreaterThan(0n);
  });

  it("moves earlier years' profit into retained earnings", async () => {
    const extra: FxEntry = { id: "9999999999999999990", date: "2024-12-15", description: "Late 2024 sale", lines: [{ account: "checking", debit: "100.00" }, { account: "sales", credit: "100.00" }] };
    const { books } = await fixtureBooks({ entries: [...ENTRIES, extra], scope: "opening-balances", cutoverDate: "2025-03-31" });
    const scoped = scopedLedger(books);
    const re = scoped.entries[0]!.lines.find((l) => l.description === "Profit from earlier fiscal years")!;
    expect(re.credit).toBe(10000n);
  });
});

describe("financial statements", () => {
  it("balance sheet balances and P&L ties to equity, every year", async () => {
    const extra: FxEntry = { id: "9999999999999999990", date: "2024-12-15", description: "Late 2024 sale", lines: [{ account: "checking", debit: "100.00" }, { account: "sales", credit: "100.00" }] };
    const { books } = await fixtureBooks({ entries: [...ENTRIES, extra] });
    const years = fiscalYears(books);
    expect(years.map((y) => y.label)).toEqual(["2024", "2025"]);
    for (const y of years) {
      const b = balanceSheet(books, y.end);
      expect(b.totalAssets, y.label).toBe(b.totalLiabilities + b.totalEquity);
      expect(b.currentYearEarnings, y.label).toBe(profitAndLoss(books, y).netIncome);
    }
    expect(balanceSheet(books, "2025-12-31").retainedEarnings).toBe(10000n);
  });

  it("supports a non-calendar fiscal year", async () => {
    const i = await inputs();
    const draft = buildBooks(i);
    const resolutions = Object.fromEntries(draft.issues.filter((x) => x.severity === "red").map((x) => [x.id, x.options[0]!.value]));
    const books = buildBooks({ ...i, settings: { resolutions, fiscalYearEndMonth: 6 } });
    expect(fiscalYears(books).map((y) => [y.start, y.end])).toEqual([["2024-07-01", "2025-06-30"], ["2025-07-01", "2026-06-30"]]);
  });
});

describe("Excel workbook", () => {
  it("matches the golden sheets", async () => {
    const { books, ctx } = await fixtureBooks();
    const [f] = await OUTPUTS.find((p) => p.id === "excel")!.produce(books, ctx);
    const z = unzipSync(f!.bytes);
    for (const [name, bytes] of Object.entries(z)) await expect(strFromU8(bytes)).toMatchFileSnapshot(`${GOLDEN}/excel/${name.replaceAll("/", "__")}`);
  });

  it("trial balance formulas sum the Journal sheet and their cached values agree with the ledger", async () => {
    const { books, ctx } = await fixtureBooks();
    const [f] = await OUTPUTS.find((p) => p.id === "excel")!.produce(books, ctx);
    const z = unzipSync(f!.bytes);
    const tb = strFromU8(z["xl/worksheets/sheet2.xml"]!);
    const formulas = [...tb.matchAll(/<f>([^<]+)<\/f><v>([^<]+)<\/v>/g)];
    expect(formulas.filter((m) => m[1]!.startsWith("SUMIFS(Journal!")).length).toBe(books.accounts.length * 3); // debit, credit, and the cutover balance
    const dr = sum(books.entries.map((e) => e.debitTotal));
    expect(tb).toContain(`<f>SUM(E2:E${books.accounts.length + 1})</f><v>${(Number(dr) / 100).toFixed(2)}</v>`);
    expect(strFromU8(z["xl/workbook.xml"]!)).toContain('fullCalcOnLoad="1"');
  });

  it("keeps text that looks like a formula as text", async () => {
    const extra: FxEntry = { id: "9999999999999999991", date: "2025-02-02", description: "=HYPERLINK(\"http://x\")", lines: [{ account: "office", debit: "1.00" }, { account: "checking", credit: "1.00" }] };
    const { books, ctx } = await fixtureBooks({ entries: [...ENTRIES, extra] });
    const [f] = await OUTPUTS.find((p) => p.id === "excel")!.produce(books, ctx);
    const journal = strFromU8(unzipSync(f!.bytes)["xl/worksheets/sheet7.xml"]!);
    expect(journal).toContain('t="inlineStr"><is><t xml:space="preserve">=HYPERLINK(&quot;http://x&quot;)</t>');
    expect(journal).not.toContain("<f>HYPERLINK");
  });
});

describe("PDF report pack", () => {
  it("matches the golden report text and is a valid PDF", async () => {
    const { books, ctx } = await fixtureBooks();
    await expect(renderText(reportPack(books, CREATED))).toMatchFileSnapshot(`${GOLDEN}/pdf-pack/report-pack.txt`);
    const [f] = await OUTPUTS.find((p) => p.id === "pdf-pack")!.produce(books, ctx);
    const pdf = await PDFDocument.load(f!.bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(5);
    expect(pdf.getTitle()).toBe("Maple & Pine Design LLC - Report pack");
  });

  it("warns when names use characters the PDF font can't show", async () => {
    const extra: FxEntry = { id: "9999999999999999992", date: "2025-02-02", description: "Café 東京", lines: [{ account: "meals", debit: "5.00" }, { account: "checking", credit: "5.00" }] };
    const { books } = await fixtureBooks({ entries: [...ENTRIES, extra] });
    const issues = OUTPUTS.find((p) => p.id === "pdf-pack")!.validate(books);
    expect(issues[0]?.explanation).toContain('"東"');
    expect(issues[0]?.explanation).not.toContain('"é"');
  });
});

describe("GL rows", () => {
  it("one row per line, the opening entry first in opening-balances scope", async () => {
    const { books } = await fixtureBooks({ scope: "opening-balances", cutoverDate: "2025-06-30" });
    const rows = glRows(books);
    expect(rows[0]![1]).toBe(OPENING_ENTRY_ID);
  });
});
