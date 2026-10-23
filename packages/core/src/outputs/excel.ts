import { formatPlain, sum } from "../money.ts";
import { trialBalance } from "../model/ledger.ts";
import type { Books, Issue } from "../model/types.ts";
import { safeFileName } from "./csv.ts";
import { TABLES, type ColumnKind, type TableSpec } from "./package/tables.ts";
import type { OutputPlugin } from "./types.ts";
import { colName, writeXlsx, type CellValue, type Sheet } from "./xlsx.ts";

/**
 * The review workbook: a summary, one sheet per universal-package file (frozen
 * header, filters, real numbers and dates), and a trial balance whose figures are
 * formulas over the Journal sheet, so an accountant can change or delete journal
 * rows and watch the trial balance move.
 */

const EXCEL_MAX_ROWS = 1_048_576;
const WIDTH: Record<ColumnKind, number> = { id: 22, code: 9, text: 28, date: 11, amount: 14, decimal: 11, integer: 8, boolean: 8, list: 24, json: 30 };
const NARROW_TEXT = new Set(["type", "role", "status", "normal_balance", "bucket", "kind", "severity", "currency", "entry_type", "lines_from", "linked_by", "applied_to_type"]);

function cell(kind: ColumnKind, v: string): CellValue {
  if (v === "") return null;
  switch (kind) {
    case "amount": return { t: "n", v, fmt: "amount" };
    case "integer": return /^-?\d+$/.test(v) ? { t: "n", v, fmt: "integer" } : { t: "s", v };
    case "decimal": return /^-?\d+(\.\d+)?$/.test(v) ? { t: "n", v, fmt: "decimal" } : { t: "s", v };
    case "date": return /^\d{4}-\d{2}-\d{2}$/.test(v) ? { t: "d", v } : { t: "s", v };
    case "boolean": return { t: "b", v: v === "true" };
    default: return { t: "s", v };
  }
}

function tableSheet(t: TableSpec, books: Books): Sheet {
  return {
    name: t.sheet,
    columns: t.columns.map((c) => ({ header: c.name, width: c.kind === "text" && NARROW_TEXT.has(c.name) ? 12 : WIDTH[c.kind] })),
    rows: t.rows(books).map((r) => r.map((v, i) => cell(t.columns[i]!.kind, v))),
  };
}

function trialBalanceSheet(books: Books, journal: TableSpec): Sheet {
  const col = (name: string) => colName(journal.columns.findIndex((c) => c.name === name));
  const [jAcc, jDr, jCr, jDate] = [col("account_id"), col("debit"), col("credit"), col("date")];
  const end = new Map(trialBalance(books.entries, books.accounts).map((r) => [r.accountId, r] as const));
  const cut = new Map(trialBalance(books.entries, books.accounts, books.period.cutoverDate).map((r) => [r.accountId, r] as const));
  const [cy, cm, cd] = books.period.cutoverDate.split("-").map(Number);
  const amt = (v: bigint) => formatPlain(v, books.business.exponent);
  const accounts = [...books.accounts].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  const rows: CellValue[][] = accounts.map((a, i) => {
    const r = i + 2;
    const e = end.get(a.id)!;
    const c = cut.get(a.id)!;
    const sumIf = (amount: string, extra = "") => `SUMIFS(Journal!$${amount}:$${amount},Journal!$${jAcc}:$${jAcc},$A${r}${extra})`;
    const byDate = `,Journal!$${jDate}:$${jDate},"<="&DATE(${cy},${cm},${cd})`;
    const sign = a.normalBalance === "DEBIT" ? `E${r}-F${r}` : `F${r}-E${r}`;
    const cutSign = a.normalBalance === "DEBIT" ? `${sumIf(jDr, byDate)}-${sumIf(jCr, byDate)}` : `${sumIf(jCr, byDate)}-${sumIf(jDr, byDate)}`;
    return [
      { t: "s", v: a.id }, { t: "s", v: a.code }, { t: "s", v: a.name }, { t: "s", v: a.type },
      { t: "f", f: sumIf(jDr), v: amt(e.debit) }, { t: "f", f: sumIf(jCr), v: amt(e.credit) },
      { t: "f", f: sign, v: amt(e.balance) },
      { t: "f", f: cutSign, v: amt(c.balance) },
    ];
  });
  const last = accounts.length + 1;
  const dr = sum([...end.values()].map((r) => r.debit));
  const cr = sum([...end.values()].map((r) => r.credit));
  rows.push([null, null, { t: "s", v: "Total" }, null, { t: "f", f: `SUM(E2:E${last})`, v: amt(dr) }, { t: "f", f: `SUM(F2:F${last})`, v: amt(cr) }, null, null]);
  rows.push([null, null, { t: "s", v: "Difference (should be 0.00)" }, null, { t: "f", f: `E${last + 1}-F${last + 1}`, v: amt(dr - cr) }, null, null, null]);
  return {
    name: "Trial Balance",
    columns: [
      { header: "account_id", width: 22 }, { header: "code", width: 9 }, { header: "account", width: 32 }, { header: "type", width: 11 },
      { header: "debit", width: 15 }, { header: "credit", width: 15 }, { header: `balance at ${books.period.lastDate}`, width: 18 },
      { header: `balance at ${books.period.cutoverDate}`, width: 18 },
    ],
    rows,
    boldRows: [rows.length - 2, rows.length - 1],
    autofilter: false,
  };
}

function summarySheet(books: Books): Sheet {
  const s = (v: string): CellValue => ({ t: "s", v });
  return {
    name: "Summary",
    columns: [{ header: "Item", width: 34 }, { header: "Value", width: 90 }],
    rows: [
      [s("Business"), s(books.business.name)],
      [s("Currency"), s(books.business.currency)],
      [s("Period"), s(`${books.period.firstDate} to ${books.period.lastDate}`)],
      [s("Cutover date"), s(books.period.cutoverDate)],
      [s("Input"), s(books.mode === "connected" ? "Transactions export and Wave connection" : "Export files only (no Wave connection)")],
      [s("Entries / lines"), s(`${books.entries.length} / ${books.entries.reduce((n, e) => n + e.lines.length, 0)}`)],
      [null, null],
      ...books.checks.map((c) => [s(`Check ${c.id}: ${c.title}`), s(`${c.status.toUpperCase()}: ${c.summary}`)]),
      [null, null],
      [s("How to use"), s("The Trial Balance sheet adds up the Journal sheet with formulas, so it updates if you change journal rows. Every other sheet is the matching file from the universal package.")],
    ],
    autofilter: false,
  };
}

export function workbookSheets(books: Books): Sheet[] {
  const journal = TABLES.find((t) => t.file === "journal.csv")!;
  return [
    summarySheet(books),
    trialBalanceSheet(books, journal),
    ...TABLES.filter((t) => t.file !== "trial_balance.csv").map((t) => tableSheet(t, books)),
  ];
}

export const excelWorkbook: OutputPlugin = {
  id: "excel",
  group: "review",
  title: "Excel workbook",
  summary: "Every table on its own sheet, with filters, and a trial balance that recomputes from the journal.",
  describe: (books) => ({
    keeps: [
      { aspect: "ledger", text: "Every ledger line, as numbers you can filter and sum." },
      { aspect: "entry-types", text: "Each entry's type and why." },
      { aspect: "chart-of-accounts", text: "The chart of accounts." },
      { aspect: "contacts", text: "Customers and vendors." },
      { aspect: "contact-details", text: "Their addresses and other details." },
      { aspect: "invoices", text: "Invoices with amounts paid and owed." },
      { aspect: "invoice-lines", text: "Invoice line items." },
      { aspect: "bills", text: "Bills." },
      { aspect: "payments", text: "Payments and what they paid." },
      { aspect: "items", text: "Products and services." },
      { aspect: "tax-rates", text: "Sales tax rates." },
      { aspect: "estimates", text: "Estimates." },
      { aspect: "trial-balance", text: `A trial balance with formulas over the journal, at ${books.period.lastDate} and at the cutover date.` },
      { aspect: "aging", text: "AR and AP aging at the cutover date." },
      { aspect: "review-answers", text: "Every review item and its answer." },
    ],
    loses: [
      { aspect: "attachments", text: "No receipt files (the Attachments sheet lists them; the files are in the universal package)." },
      { aspect: "yearly-statements", text: "No P&L or balance sheet by year: use the PDF report pack." },
      { aspect: "tie-out", text: "Check results only on the Summary sheet; the full tie-out report is a PDF." },
    ],
    withoutConnection: books.mode === "export-file-only" ? ["Products, sales taxes and estimates sheets are empty"] : [],
  }),
  validate(books): Issue[] {
    const big = TABLES.map((t) => ({ t, n: t.rows(books).length })).filter((x) => x.n + 1 > EXCEL_MAX_ROWS);
    return big.map(({ t, n }) => ({
      id: `excel-too-many-rows:${t.file}`, kind: "output-limit", severity: "red",
      title: `${t.sheet} has more rows than Excel allows`,
      explanation: `${n} rows won't fit in one Excel sheet (the limit is ${EXCEL_MAX_ROWS - 1}). Use the universal package's CSV files instead.`,
      options: [], refs: [],
    }));
  },
  async produce(books, ctx) {
    const bytes = writeXlsx(workbookSheets(books), { title: `${books.business.name} – Wave books`, created: ctx.createdAt });
    return [{
      name: `${safeFileName(books.business.name)} – Wave books – ${ctx.createdAt.toISOString().slice(0, 10)}.xlsx`,
      bytes, mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }];
  },
};
