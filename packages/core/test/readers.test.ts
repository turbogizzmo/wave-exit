import { parse } from "csv-parse/sync";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { InputProblem, looksLikeReceiptsExport, looksLikeTransactionsExport, readReceiptsExport, readTransactionsExport, type InputFile } from "../src/index.ts";
import { accountingCsv, billItemsCsv, customersCsv, ENTRIES, receiptsZip, transactionsZip, vendorsCsv } from "./fixtures/synthetic.ts";

const zipFile = (bytes: Uint8Array, path = "5f0c1d2e-0000-4000-8000-000000000000.zip"): InputFile => ({ path, bytes });

async function problem(p: Promise<unknown>): Promise<InputProblem> {
  try {
    await p;
  } catch (e) {
    if (e instanceof InputProblem) return e;
    throw e;
  }
  throw new Error("expected an InputProblem");
}

describe("transactions export reader", () => {
  it("reads Wave's ZIP", async () => {
    const tx = await readTransactionsExport([zipFile(transactionsZip())]);
    const lines = ENTRIES.reduce((n, e) => n + e.lines.length, 0);
    expect(tx.summary).toMatchObject({ rows: lines, transactions: ENTRIES.length, firstDate: "2025-01-01", lastDate: "2025-12-31" });
    expect(tx.files.map((f) => [f.name, f.rows])).toEqual([["accounting.csv", lines], ["customers.csv", 3], ["vendors.csv", 5], ["bill_items.csv", 1]]);
    expect(tx.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    expect(tx.exportedAt?.getUTCFullYear()).toBe(2026);
    expect(tx.notes.some((n) => n.message.includes("bills"))).toBe(true);
    const row = tx.ledger.find((r) => r.invoiceNumber === "1002" && r.salesTaxAmount)!;
    expect(row.salesTaxName).toBe("State Sales Tax");
  });

  it("reads the unzipped folder and loose files the same way", async () => {
    const files = { "accounting.csv": accountingCsv(), "customers.csv": customersCsv(), "vendors.csv": vendorsCsv(), "bill_items.csv": billItemsCsv() };
    const folder = Object.entries(files).map(([k, v]) => ({ path: `export/${k}`, bytes: strToU8(v) }));
    const a = await readTransactionsExport(folder);
    const b = await readTransactionsExport([zipFile(transactionsZip())]);
    expect(a.ledger).toEqual(b.ledger);
    expect(looksLikeTransactionsExport(folder)).toBe(true);
  });

  it("parses by header name, not position (the spacer column header is a single space)", async () => {
    const recs = parse(accountingCsv()) as string[][];
    expect(recs[0]).toContain(" ");
    const reversed = recs.map((r) => [...r].reverse().map((c) => (/[",\n]/.test(c) ? `"${c.replaceAll('"', '""')}"` : c)).join(",")).join("\n");
    const a = await readTransactionsExport([zipFile(transactionsZip({ ledgerCsv: reversed }))]);
    const b = await readTransactionsExport([zipFile(transactionsZip())]);
    expect(a.ledger).toEqual(b.ledger);
  });

  it("accepts a UTF-8 BOM", async () => {
    const tx = await readTransactionsExport([zipFile(transactionsZip({ ledgerCsv: "﻿" + accountingCsv() }))]);
    expect(tx.ledger.length).toBeGreaterThan(0);
  });

  it("refuses a file that isn't a Wave export, in plain words", async () => {
    const p = await problem(readTransactionsExport([zipFile(zipSync({ "notes.txt": strToU8("hello") }))]));
    expect(p.code).toBe("not-a-wave-export");
    expect(p.nextStep).toContain("Export all transactions as CSV");
  });

  it("refuses an incomplete export", async () => {
    const p = await problem(readTransactionsExport([zipFile(transactionsZip({ omit: ["vendors.csv"] }))]));
    expect(p.code).toBe("missing-file");
    expect(p.explanation).toContain("vendors.csv");
  });

  it("refuses a cut-off download", async () => {
    const full = transactionsZip();
    const p = await problem(readTransactionsExport([zipFile(full.slice(0, Math.floor(full.length / 2)))]));
    expect(p.code).toBe("damaged-file");
  });

  it("names every missing column", async () => {
    const csv = accountingCsv().replace("Account Group", "Group").replace("Account Type", "Type");
    const p = await problem(readTransactionsExport([zipFile(transactionsZip({ ledgerCsv: csv }))]));
    expect(p.code).toBe("missing-columns");
    expect(p.explanation).toContain('"Account Group"');
    expect(p.explanation).toContain('"Account Type"');
  });

  it("refuses bad values with the row number in the support details", async () => {
    const csv = accountingCsv().replace("123.45", "12x3.45");
    const p = await problem(readTransactionsExport([zipFile(transactionsZip({ ledgerCsv: csv }))]));
    expect(p.code).toBe("bad-value");
    expect(p.detail).toMatch(/row \d+/);
  });

  it("says plainly that the Excel variant isn't read yet", async () => {
    const z = zipSync({ "accounting.xls": strToU8("x"), "customers.xls": strToU8("x") });
    const p = await problem(readTransactionsExport([zipFile(z)]));
    expect(p.code).toBe("unsupported-format");
  });

  it("refuses an export with no transactions", async () => {
    const header = accountingCsv().split("\n")[0] + "\n";
    const p = await problem(readTransactionsExport([zipFile(transactionsZip({ ledgerCsv: header }))]));
    expect(p.code).toBe("empty-export");
  });

  it("notes, but tolerates, a one-column amount that disagrees with debit/credit", async () => {
    const csv = accountingCsv().replace(/(Owner investment,,)10000\.00/, "$1-10000.00");
    const tx = await readTransactionsExport([zipFile(transactionsZip({ ledgerCsv: csv }))]);
    expect(tx.notes.find((n) => n.severity === "warning")?.rows).toHaveLength(1);
  });
});

describe("receipts export reader", () => {
  it("reads Wave's receipts ZIP", async () => {
    const r = await readReceiptsExport([zipFile(receiptsZip(), "owner@maple-pine.example-2026-01-15-12-00-00.zip")]);
    expect(r.receipts.map((x) => [x.date, x.description, x.extension])).toEqual([
      ["2025-01-05", "PAPER PLANET #221", "pdf"],
      ["2025-09-12", "CORNER COFFEE", "jpg"],
      ["2025-09-30", "UNKNOWN SHOP", "png"],
    ]);
    expect(looksLikeReceiptsExport([zipFile(receiptsZip())])).toBe(true);
    expect(looksLikeReceiptsExport([zipFile(transactionsZip())])).toBe(false);
  });

  it("keeps oddly named files as unlinked attachments", async () => {
    const z = zipSync({ "2025-01-05-A.pdf": strToU8("a"), "scan.pdf": strToU8("b") });
    const r = await readReceiptsExport([zipFile(z)]);
    expect(r.receipts).toHaveLength(2);
    expect(r.receipts.find((x) => x.fileName === "scan.pdf")?.date).toBe("");
    expect(r.notes[0]?.severity).toBe("warning");
  });
});
