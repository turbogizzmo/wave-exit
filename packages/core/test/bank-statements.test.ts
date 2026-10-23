import { parse } from "csv-parse/sync";
import fc from "fast-check";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  accountStatements, APP_VERSION, bankStatementFiles, buildBooks, ofxText, quickBooksCsv, splitStatement, sum, trialBalance, writeOfx,
  type Books, type OutputContext, type Statement,
} from "../src/index.ts";
import { E } from "./fixtures/synthetic.ts";
import { inputs } from "./helpers.ts";

const CREATED = new Date("2026-01-20T10:00:00Z");

async function fixtureBooks(settings: Partial<Books["settings"]> = {}): Promise<Books> {
  const i = await inputs();
  const draft = buildBooks(i);
  const resolutions = Object.fromEntries(draft.issues.filter((x) => x.severity === "red").map((x) => [x.id, x.options[0]!.value]));
  return buildBooks({ ...i, settings: { resolutions, ...settings } });
}
const ctx = (options: OutputContext["options"] = {}): OutputContext => ({ createdAt: CREATED, appVersion: APP_VERSION, attachments: new Map(), options });

/** A tiny independent OFX reader for the tests: leaf tags inside each STMTTRN. */
function readOfx(text: string) {
  const txns = [...text.matchAll(/<STMTTRN>([\s\S]*?)<\/STMTTRN>/g)].map((m) => Object.fromEntries([...m[1]!.matchAll(/<([A-Z.]+)>([^\r\n<]*)/g)].map((x) => [x[1]!, x[2]!])));
  const bal = /<BALAMT>([^\r\n]+)/.exec(text)?.[1];
  return { txns, bal, cc: text.includes("<CCSTMTRS>"), bid: /<INTU\.BID>([^\r\n]+)/.exec(text)?.[1] };
}

describe("bank statement files", () => {
  it("make one statement per bank and card account, amounts from the account holder's side", async () => {
    const books = await fixtureBooks();
    const stmts = accountStatements(books);
    expect(stmts.map((s) => [s.account.name, s.statement.kind, s.statement.lines.length])).toEqual([
      ["Business Checking", "bank", 17], ["Business Savings", "bank", 2], ["Visa Card", "creditCard", 6],
    ]);
    // Statement balance = ledger balance (debit − credit) for every account.
    const tb = new Map(trialBalance(books.entries, books.accounts).map((r) => [r.accountId, r.debit - r.credit] as const));
    for (const s of stmts) expect(s.statement.ledgerBalance, s.account.name).toBe(tb.get(s.account.id));
    // A card purchase is negative, the card payment positive (OFX 2.3 §11.4.4.1).
    const visa = stmts.find((s) => s.statement.kind === "creditCard")!.statement.lines;
    expect(visa.find((l) => l.fitid.startsWith(E(3).id))!.amount).toBe(-4900n);
    expect(visa.find((l) => l.fitid.startsWith(E(20).id))!.amount).toBe(45000n);
    // The zero-amount entry is left out, and counted.
    expect(stmts.find((s) => s.statement.kind === "creditCard")!.zeroLines).toBe(1);
  });

  it("lays out folders per destination, with .qbo/.qfx only when a bank ID is given", async () => {
    const books = await fixtureBooks();
    const names = async (o: OutputContext["options"]) => Object.keys(unzipSync((await bankStatementFiles.produce(books, ctx(o)))[0]!.bytes));
    const without = await names({});
    expect(without.filter((n) => /\.(qbo|qfx)$/.test(n))).toEqual([]);
    expect(without[0]).toBe("README.txt");
    const withBid = await names({ "bank-statements": { intuitBid: "12345" } });
    expect(withBid.filter((n) => n.endsWith(".qbo"))).toHaveLength(3);
    expect(withBid.filter((n) => n.endsWith(".qfx"))).toHaveLength(3);
  });

  it("matches the golden files", async () => {
    const books = await fixtureBooks();
    const z = unzipSync((await bankStatementFiles.produce(books, ctx({ "bank-statements": { intuitBid: "12345" } })))[0]!.bytes);
    for (const [name, bytes] of Object.entries(z)) await expect(strFromU8(bytes)).toMatchFileSnapshot(`./golden/bank-statements/${name.replaceAll("/", "__")}`);
  });

  it("all formats carry the same transactions and totals", async () => {
    const books = await fixtureBooks();
    const z = unzipSync((await bankStatementFiles.produce(books, ctx({ "bank-statements": { intuitBid: "12345" } })))[0]!.bytes);
    for (const s of accountStatements(books)) {
      const base = `${s.account.code} ${s.account.name}`;
      const total = sum(s.statement.lines.map((l) => l.amount));
      const cents = (v: string) => BigInt(v.replace("-", "").replace(".", "")) * (v.startsWith("-") ? -1n : 1n);
      const ofx = readOfx(strFromU8(z[`Xero/${base}.ofx`]!));
      const qbo = readOfx(strFromU8(z[`QuickBooks Online/${base}.qbo`]!));
      const qcsv = parse(strFromU8(z[`QuickBooks Online/${base}.csv`]!), { bom: true, columns: true }) as Record<string, string>[];
      const xcsv = parse(strFromU8(z[`Xero/${base}.csv`]!), { bom: true, columns: true }) as Record<string, string>[];
      expect(sum(ofx.txns.map((t) => cents(t.TRNAMT!))), base).toBe(total);
      expect(sum(qcsv.map((r) => cents(r.Amount!))), base).toBe(total);
      expect(sum(xcsv.map((r) => cents(r.Amount!))), base).toBe(total);
      expect(ofx.cc).toBe(s.statement.kind === "creditCard");
      expect(qbo.bid).toBe("12345");
      expect(ofx.bid).toBeUndefined();
      expect(new Set(ofx.txns.map((t) => t.FITID)).size).toBe(ofx.txns.length);
      expect(xcsv.map((r) => r.Reference)).toEqual(ofx.txns.map((t) => t.FITID));
      // Formats each vendor documents.
      expect(qcsv.every((r) => /^\d{2}\/\d{2}\/\d{4}$/.test(r.Date!) && r.Amount !== "0.00")).toBe(true);
      expect(xcsv.every((r) => /^\d{4}\/\d{2}\/\d{2}$/.test(r.Date!) && !r.Amount!.includes(","))).toBe(true);
    }
  });

  it("follows the opening-balances scope: only later transactions, with the opening balance stated", async () => {
    const books = await fixtureBooks({ scope: "opening-balances", cutoverDate: "2025-04-30" });
    const checking = accountStatements(books).find((s) => s.account.name === "Business Checking")!;
    expect(checking.statement.lines.every((l) => l.date > "2025-04-30")).toBe(true);
    const tbAtCut = trialBalance(books.entries, books.accounts, "2025-04-30").find((r) => r.accountId === checking.account.id)!;
    expect(checking.openingBalance).toBe(tbAtCut.debit - tbAtCut.credit);
    const full = trialBalance(books.entries, books.accounts).find((r) => r.accountId === checking.account.id)!;
    expect(checking.statement.ledgerBalance).toBe(full.debit - full.credit);
    const readme = strFromU8(unzipSync((await bankStatementFiles.produce(books, ctx()))[0]!.bytes)["README.txt"]!);
    expect(readme).toContain("Only transactions after the cutover date 2025-04-30");
  });

  it("states what it keeps and loses", async () => {
    const books = await fixtureBooks();
    const d = bankStatementFiles.describe(books);
    expect(d.keeps.map((k) => k.aspect)).toEqual(["bank-transactions"]);
    expect(d.loses.map((k) => k.aspect)).toContain("categories");
    const z = unzipSync((await bankStatementFiles.produce(books, ctx()))[0]!.bytes);
    // Loses attachments and invoices: no such files in the output.
    expect(Object.keys(z).some((n) => /attachments|invoice/i.test(n))).toBe(false);
    // Loses categories: no expense or income account named in any statement file.
    const text = Object.values(z).map((b) => strFromU8(b)).join("\n");
    for (const a of books.accounts.filter((x) => x.role === "expense" || x.role === "income")) expect(text.includes(a.name), a.name).toBe(false);
  });
});

describe("splitting for QuickBooks' upload limits", () => {
  const statement = (days: number[], perDay: number[]): Statement => ({
    kind: "bank", accountId: "A", bankId: "0", accountType: "CHECKING", currency: "USD", exponent: 2,
    start: "", end: "", ledgerBalance: 0n,
    lines: days.flatMap((d, i) => Array.from({ length: perDay[i]! }, (_, k) => ({
      fitid: `${d}-${k}`, date: new Date(Date.UTC(2024, 0, 1) + d * 86_400_000).toISOString().slice(0, 10),
      amount: BigInt((d * 37 + k * 11) % 50_000 - 20_000) || 1n, type: "DEBIT" as const, name: `Payee ${d}`, memo: "x".repeat(k % 40),
    }))),
  });

  it("keeps every part within 1,000 lines and 350 KB, in order, never losing a line or a cent", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 400 }), { minLength: 1, maxLength: 12 }), (perDay) => {
        const st = statement(perDay.map((_, i) => i * 3), perDay);
        const fits = (p: Statement) => p.lines.length <= 1000 && new TextEncoder().encode(quickBooksCsv(p)).length <= 350 * 1024;
        const parts = splitStatement(st, 500n, fits);
        expect(parts.flatMap((p) => p.lines)).toEqual(st.lines);
        expect(parts.every(fits)).toBe(true);
        // Running balances carry from one part to the next.
        let bal = 500n;
        for (const p of parts) {
          bal += sum(p.lines.map((l) => l.amount));
          expect(p.ledgerBalance).toBe(bal);
        }
        // A day is never split across parts when it fits in one.
        for (let i = 1; i < parts.length; i++) {
          const prevDay = parts[i - 1]!.lines.at(-1)!.date;
          if (st.lines.filter((l) => l.date === prevDay).length <= 1000) expect(parts[i]!.lines[0]!.date).not.toBe(prevDay);
        }
      }),
      { numRuns: 40 },
    );
  });

  it("splits a 2,500-line account into three parts", () => {
    const st = statement([0, 1, 2, 3, 4], [500, 500, 500, 500, 500]);
    const parts = splitStatement(st, 0n, (p) => p.lines.length <= 1000);
    expect(parts.map((p) => p.lines.length)).toEqual([1000, 1000, 500]);
  });
});

describe("OFX writer", () => {
  it("keeps text within OFX's element lengths and markup-free", () => {
    expect(ofxText("A & B <Co> Café", 32)).toBe("A and B (Co) Cafe");
    expect(ofxText("x".repeat(40), 32)).toHaveLength(32);
    const st: Statement = {
      kind: "bank", accountId: "WAVEEXIT1030", bankId: "000000000", accountType: "CHECKING", currency: "USD", exponent: 2,
      start: "2025-01-01", end: "2025-01-01", ledgerBalance: -5n,
      lines: [{ fitid: "1-1", date: "2025-01-01", amount: -5n, type: "DEBIT", name: "A very long payee name that goes on and on", memo: "m" }],
    };
    const text = writeOfx(st, { created: CREATED });
    expect(text.startsWith("OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\n")).toBe(true);
    expect(/<NAME>([^\r\n]*)/.exec(text)![1]!.length).toBeLessThanOrEqual(32);
    expect(text).toContain("<TRNAMT>-0.05");
    expect(text).toContain("<DTPOSTED>20250101120000");
  });
});
