import { baseName, expandZips, isZip, sha256Hex, zipEntryTimes, type InputFile } from "../input/files.ts";
import { Columns, readCsv, type Table } from "../input/table.ts";
import { AmountFormatError, parseAmount, parseOptionalAmount, type Minor } from "../money.ts";
import { InputProblem } from "../problems.ts";
import type { ReaderNote, SourceFileInfo } from "./common.ts";

/**
 * Reader for Wave's "Export all transactions as CSV" download: a ZIP named with a
 * bare UUID holding accounting.csv, customers.csv, vendors.csv and bill_items.csv.
 * Format spec: docs/wave-formats.md. Accepts the ZIP, the unzipped folder, or the
 * loose files.
 */

export const ACCOUNT_GROUPS = ["Asset", "Liability", "Equity", "Income", "Expense"] as const;
export type AccountGroup = (typeof ACCOUNT_GROUPS)[number];

export interface LedgerRow {
  /** 1-based data row number in accounting.csv (header excluded), for messages. */
  row: number;
  transactionId: string;
  date: string;
  accountName: string;
  accountGroup: AccountGroup;
  accountType: string;
  description: string;
  lineDescription: string;
  debit: Minor;
  credit: Minor;
  /** Signed in the account's normal-balance direction. */
  amountOneColumn: Minor;
  customer: string;
  vendor: string;
  invoiceNumber: string;
  billNumber: string;
  memo: string;
  /** Sales tax columns: format unverified (no real export has used them), kept as text. */
  amountBeforeSalesTax: string;
  salesTaxAmount: string;
  salesTaxName: string;
  dateAdded: string;
  dateModified: string;
  /** Always empty in every export seen so far. */
  accountId: string;
}

export interface ContactRow {
  row: number;
  name: string;
  email: string;
  currency: string;
  /** Every column, keyed by Wave's snake_case header, for outputs that want the rest. */
  fields: Record<string, string>;
}

/** bill_items.csv. Value formats unverified: no real export with bills has been seen. */
export interface BillItemRow {
  row: number;
  fields: Record<string, string>;
}

export interface TransactionsExport {
  kind: "transactions-export";
  files: SourceFileInfo[];
  ledger: LedgerRow[];
  customers: ContactRow[];
  vendors: ContactRow[];
  billItems: BillItemRow[];
  /** When Wave wrote the files (ZIP entry time), if known. */
  exportedAt?: Date;
  notes: ReaderNote[];
  summary: {
    rows: number;
    transactions: number;
    firstDate: string;
    lastDate: string;
    lastModified: string;
  };
}

const LEDGER_FILE = "accounting.csv";
const OTHER_FILES = ["customers.csv", "vendors.csv", "bill_items.csv"] as const;

const LEDGER_REQUIRED = [
  "Transaction ID",
  "Transaction Date",
  "Account Name",
  "Transaction Description",
  "Debit Amount (Two Column Approach)",
  "Credit Amount (Two Column Approach)",
  "Account Group",
  "Account Type",
] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TXN_ID = /^\d+$/;

/** True when the files look like a transactions export (used for drop-anywhere routing). */
export function looksLikeTransactionsExport(files: InputFile[]): boolean {
  return expandZips(files).some((f) => /^accounting\.(csv|xlsx?)$/i.test(baseName(f.path)));
}

export async function readTransactionsExport(
  input: InputFile[],
  opts: { exponent?: number } = {},
): Promise<TransactionsExport> {
  const exponent = opts.exponent ?? 2;
  let exportedAt: Date | undefined;
  for (const f of input) {
    if (!isZip(f)) continue;
    const t = zipEntryTimes(f.bytes).get(LEDGER_FILE);
    if (t) exportedAt = t;
  }
  const files = expandZips(input);
  const byName = new Map(files.map((f) => [baseName(f.path).toLowerCase(), f] as const));

  if (!byName.has(LEDGER_FILE)) {
    if (byName.has("accounting.xls") || byName.has("accounting.xlsx")) {
      throw new InputProblem(
        "unsupported-format",
        "This is Wave's Excel version of the transactions export. Wave Exit reads the CSV version, because its layout has been checked against real exports.",
        `In Wave, go to Settings → Data Export and choose "Export all transactions as CSV".`,
      );
    }
    throw new InputProblem(
      "not-a-wave-export",
      "This doesn't look like a Wave transactions export: it has no accounting.csv file inside.",
      `In Wave, go to Settings → Data Export and choose "Export all transactions as CSV", then add the ZIP from Wave's email.`,
      `files: ${files.map((f) => f.path).join(", ")}`,
    );
  }
  const missing = OTHER_FILES.filter((n) => !byName.has(n));
  if (missing.length) {
    throw new InputProblem(
      "missing-file",
      `The export is incomplete: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. A complete Wave export always has four files.`,
      "Add the whole ZIP from Wave's email rather than single files, or request a new export.",
    );
  }

  const notes: ReaderNote[] = [];
  const sourceInfo = async (name: string, rows: number): Promise<SourceFileInfo> => {
    const f = byName.get(name)!;
    return { name, bytes: f.bytes.length, sha256: await sha256Hex(f.bytes), rows };
  };

  const ledgerTable = readCsv(byName.get(LEDGER_FILE)!.bytes, LEDGER_FILE);
  const ledger = readLedger(ledgerTable, exponent, notes);
  if (ledger.length === 0) {
    throw new InputProblem(
      "empty-export",
      "This export has no transactions in it, so there is nothing to convert.",
      "Check that the right business was selected in Wave when the export was requested.",
    );
  }
  const customers = readContacts(readCsv(byName.get("customers.csv")!.bytes, "customers.csv"), "customer_name");
  const vendors = readContacts(readCsv(byName.get("vendors.csv")!.bytes, "vendors.csv"), "vendor_name");
  const billTable = readCsv(byName.get("bill_items.csv")!.bytes, "bill_items.csv");
  new Columns(billTable, ["vendor", "amount", "bill_date"] as const);
  const billItems = billTable.rows.map((r, i) => ({ row: i + 1, fields: record(billTable.headers, r) }));
  if (billItems.length) {
    notes.push({
      severity: "info",
      message: `bill_items.csv has ${billItems.length} ${billItems.length === 1 ? "row" : "rows"}. Wave Exit hasn't yet been checked against a real export that uses bills, so review the bills carefully.`,
    });
  }

  const dates = ledger.map((r) => r.date).sort();
  const modified = ledger.map((r) => r.dateModified).filter(Boolean).sort();
  return {
    kind: "transactions-export",
    files: [
      await sourceInfo(LEDGER_FILE, ledger.length),
      await sourceInfo("customers.csv", customers.length),
      await sourceInfo("vendors.csv", vendors.length),
      await sourceInfo("bill_items.csv", billItems.length),
    ],
    ledger,
    customers,
    vendors,
    billItems,
    ...(exportedAt ? { exportedAt } : {}),
    notes,
    summary: {
      rows: ledger.length,
      transactions: new Set(ledger.map((r) => r.transactionId)).size,
      firstDate: dates[0]!,
      lastDate: dates.at(-1)!,
      lastModified: modified.at(-1) ?? "",
    },
  };
}

function readLedger(table: Table, exponent: number, notes: ReaderNote[]): LedgerRow[] {
  const c = new Columns(table, LEDGER_REQUIRED);
  const problems: string[] = [];
  const signMismatches: number[] = [];
  const out: LedgerRow[] = [];

  table.rows.forEach((r, i) => {
    const row = i + 1;
    const bad = (what: string) => problems.push(`row ${row}: ${what}`);
    const transactionId = c.get(r, "Transaction ID").trim();
    const date = c.get(r, "Transaction Date").trim();
    const group = c.get(r, "Account Group").trim();
    if (!TXN_ID.test(transactionId)) bad(`Transaction ID ${JSON.stringify(transactionId)}`);
    if (!DATE.test(date)) bad(`Transaction Date ${JSON.stringify(date)}`);
    if (!(ACCOUNT_GROUPS as readonly string[]).includes(group)) bad(`Account Group ${JSON.stringify(group)}`);
    if (!c.get(r, "Account Name").trim()) bad("empty Account Name");

    let debit = 0n, credit = 0n, one = 0n;
    try {
      debit = parseOptionalAmount(c.get(r, "Debit Amount (Two Column Approach)"), exponent);
      credit = parseOptionalAmount(c.get(r, "Credit Amount (Two Column Approach)"), exponent);
      one = c.has("Amount (One column)") ? parseOptionalAmount(c.get(r, "Amount (One column)"), exponent) : 0n;
    } catch (e) {
      bad(e instanceof AmountFormatError ? `amount ${JSON.stringify(e.input)}` : String(e));
    }
    if (debit < 0n || credit < 0n) bad("negative debit or credit");
    if (debit !== 0n && credit !== 0n) bad("both a debit and a credit");

    const g = group as AccountGroup;
    if (c.has("Amount (One column)")) {
      const expected = g === "Asset" || g === "Expense" ? debit - credit : credit - debit;
      if (expected !== one) signMismatches.push(row);
    }

    out.push({
      row,
      transactionId,
      date,
      accountName: c.get(r, "Account Name"),
      accountGroup: g,
      accountType: c.get(r, "Account Type").trim(),
      description: c.get(r, "Transaction Description"),
      lineDescription: c.get(r, "Transaction Line Description"),
      debit,
      credit,
      amountOneColumn: one,
      customer: c.get(r, "Customer").trim(),
      vendor: c.get(r, "Vendor").trim(),
      invoiceNumber: c.get(r, "Invoice Number").trim(),
      billNumber: c.get(r, "Bill Number").trim(),
      memo: c.get(r, "Notes / Memo"),
      amountBeforeSalesTax: c.get(r, "Amount Before Sales Tax").trim(),
      salesTaxAmount: c.get(r, "Sales Tax Amount").trim(),
      salesTaxName: c.get(r, "Sales Tax Name").trim(),
      dateAdded: c.get(r, "Transaction Date Added").trim(),
      dateModified: c.get(r, "Transaction Date Last Modified").trim(),
      accountId: c.get(r, "Account ID").trim(),
    });
  });

  if (problems.length) {
    throw new InputProblem(
      "bad-value",
      `accounting.csv has ${problems.length} ${problems.length === 1 ? "line" : "lines"} Wave Exit can't read (first: ${problems[0]}). The file may have been edited, or Wave changed its format.`,
      "Use an untouched export from Wave. If it still fails, copy the details for support.",
      problems.slice(0, 50).join("\n"),
    );
  }
  if (signMismatches.length) {
    notes.push({
      severity: "warning",
      message: `${signMismatches.length} lines have a one-column amount that doesn't match their debit or credit. Wave Exit uses the debit and credit columns.`,
      rows: signMismatches.slice(0, 50),
    });
  }
  if (out.some((r) => r.accountId)) {
    notes.push({ severity: "info", message: "This export fills the Account ID column, which earlier exports left empty." });
  }
  return out;
}

function record(headers: string[], row: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  headers.forEach((h, i) => {
    if (h.trim() && !(h in o)) o[h] = row[i] ?? "";
  });
  return o;
}

function readContacts(table: Table, nameColumn: "customer_name" | "vendor_name"): ContactRow[] {
  const prefix = nameColumn.replace("_name", "");
  const c = new Columns(table, [nameColumn] as const);
  return table.rows
    .map((r, i) => ({
      row: i + 1,
      name: c.get(r, nameColumn).trim(),
      email: c.get(r, "email").trim(),
      currency: c.get(r, `${prefix}_currency`).trim(),
      fields: record(table.headers, r),
    }))
    .filter((r) => r.name);
}
