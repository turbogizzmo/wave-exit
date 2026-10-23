/**
 * A synthetic Wave business, "Maple & Pine Design LLC". Every name and amount is
 * invented. It is built to exercise every awkward case in the brief: duplicate
 * account names (Wave system accounts and user duplicates), an archived account
 * with history, part-paid invoices, split payments, one deposit paying two
 * invoices, a payment with a processing fee, sales tax, a discount line, bills, a
 * transfer between bank accounts, transfers and a card payment through Transfer
 * Clearing, an unpaired transfer leg, a credit card refund, a multi-line journal,
 * a 21-line entry, a zero-amount entry, an unapplied customer credit and receipts
 * (unique, ambiguous and unmatched).
 *
 * From one definition it produces the transactions ZIP and receipts ZIP in Wave's
 * real layout (docs/wave-formats.md) and a fake Wave API that answers the app's
 * queries the way the live API does (docs/wave-api.md): money with thousands
 * separators in `value`, `minorUnitValue` in cents, base64 global IDs, archived
 * rows only when asked for.
 *
 * Bills and sales tax columns use a guessed format: no real export with them has
 * been seen yet.
 */
import { strToU8, zipSync } from "fflate";
import type { Fetch } from "../../src/readers/wave-api/client.ts";

// ---- chart -------------------------------------------------------------------

export interface FxAccount {
  key: string;
  waveId: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
  subtype: string;
  /** Display name as the export writes it in `Account Type` (the catalogue name). */
  exportType: string;
  /** As `Account.subtype.name` returns it on account nodes (differs for some). */
  nodeSubtypeName: string;
  archived?: boolean;
  /** Balance Wave reports, if it differs from what the ledger gives (for tests). */
  balanceOverride?: string;
}

const gid = (kind: string, n: number) => b64(`${kind}:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const BUSINESS_UUID = "11111111-2222-4333-8444-555555555555";
export const BUSINESS_ID = b64(`Business:${BUSINESS_UUID}`);

let accN = 0;
const A = (key: string, name: string, type: FxAccount["type"], subtype: string, exportType: string, nodeSubtypeName = exportType, extra: Partial<FxAccount> = {}): FxAccount =>
  ({ key, waveId: gid("Account", ++accN), name, type, subtype, exportType, nodeSubtypeName, ...extra });

export const ACCOUNTS: FxAccount[] = [
  A("checking", "Business Checking", "ASSET", "CASH_AND_BANK", "Cash and Bank", "Cash & Bank"),
  A("savings", "Business Savings", "ASSET", "CASH_AND_BANK", "Cash and Bank", "Cash & Bank"),
  A("visa", "Visa Card", "LIABILITY", "CREDIT_CARD", "Credit Card"),
  A("ar1", "Accounts Receivable", "ASSET", "RECEIVABLE_INVOICES", "System Receivable Invoice"),
  A("ar2", "Accounts Receivable", "ASSET", "RECEIVABLE_INVOICES", "System Receivable Invoice"),
  A("ar3", "Accounts Receivable", "ASSET", "RECEIVABLE_INVOICES", "System Receivable Invoice"),
  A("arOther", "Accounts Receivable", "ASSET", "RECEIVABLE_OTHER", "System Receivable Non-Invoice"),
  A("tc1", "Transfer Clearing", "ASSET", "TRANSFERS", "Transfers"),
  A("tc2", "Transfer Clearing", "ASSET", "TRANSFERS", "Transfers"),
  A("tc3", "Transfer Clearing", "ASSET", "TRANSFERS", "Transfers"),
  A("tc4", "Transfer Clearing", "ASSET", "TRANSFERS", "Transfers"),
  A("ap", "Accounts Payable", "LIABILITY", "PAYABLE_BILLS", "System Payable Bill"),
  A("salesTax", "Sales Tax Payable", "LIABILITY", "SALES_TAX", "Sales Tax on Sales and Purchases"),
  A("owner", "Owner Investment / Drawings", "EQUITY", "NON_RETAINED_EARNINGS", "Business Owner Contribution and Drawing"),
  A("sales", "Sales", "INCOME", "INCOME", "Income"),
  A("consulting", "Consulting Income", "INCOME", "INCOME", "Income"),
  A("otherIncome", "Interest Income", "INCOME", "OTHER_INCOME", "Other Income"),
  A("discount", "Discounts Given", "INCOME", "DISCOUNTS", "Discount"),
  A("office", "Office Supplies", "EXPENSE", "EXPENSE", "Operating Expense", "Expense"),
  A("officeDup", "Office Supplies", "EXPENSE", "EXPENSE", "Operating Expense", "Expense"), // QuickBooks-import duplicate, never used
  A("software", "Software", "EXPENSE", "EXPENSE", "Operating Expense", "Expense"),
  A("softwareDup", "Software", "EXPENSE", "EXPENSE", "Operating Expense", "Expense"), // ambiguous: both zero balance
  A("lease", "Old Printer Lease", "EXPENSE", "EXPENSE", "Operating Expense", "Expense", { archived: true }),
  A("printing", "Printing", "EXPENSE", "COST_OF_GOODS_SOLD", "Cost of Goods Sold"),
  A("fees", "Payment Processing Fees", "EXPENSE", "PAYMENT_PROCESSING_FEES", "Payment Processing Fee"),
  A("meals", "Meals & Entertainment", "EXPENSE", "EXPENSE", "Operating Expense", "Expense"),
  A("depreciation", "Depreciation", "EXPENSE", "EXPENSE", "Operating Expense", "Expense"),
  A("equipment", "Equipment", "ASSET", "PROPERTY_PLANT_EQUIPMENT", "Property, Plant, Equipment"),
  A("prepaid", "Prepaid Expenses", "ASSET", "OTHER_CURRENT_ASSETS", "Other Short-Term Asset"),
  A("unused", "Vehicle Loan", "LIABILITY", "LOANS", "Loan and Line of Credit"), // no activity: only in the API chart
];
const acct = (key: string) => ACCOUNTS.find((a) => a.key === key)!;

// Which of a duplicate set the ledger lines really belong to (for balances).
const POSTS_TO: Record<string, string> = { ar: "ar1", tc: "tc2" };

// ---- contacts ----------------------------------------------------------------

export const CUSTOMERS = [
  { waveId: gid("Customer", 1), name: "Birch Studio", email: "accounts@birch.example" },
  { waveId: gid("Customer", 2), name: "Cedar & Co", email: "ap@cedar.example" },
  { waveId: gid("Customer", 3), name: "Walk-in Customer", email: "" },
  { waveId: gid("Customer", 4), name: "Dogwood Partners", email: "" }, // API only, no activity
];
export const VENDORS = [
  { waveId: gid("Vendor", 1), name: "Paper Planet" },
  { waveId: gid("Vendor", 2), name: "Cloudware Inc" },
  { waveId: gid("Vendor", 3), name: "Granite Print Co" },
  { waveId: gid("Vendor", 4), name: "Corner Coffee" },
  { waveId: gid("Vendor", 5), name: "Lease Masters" },
];

// ---- ledger ------------------------------------------------------------------

export interface FxLine {
  account: string;
  debit?: string;
  credit?: string;
  lineDescription?: string;
  invoice?: string;
  bill?: string;
  customer?: string;
  vendor?: string;
  taxName?: string;
  taxAmount?: string;
}

export interface FxEntry {
  id: string;
  date: string;
  description: string;
  lines: FxLine[];
  memo?: string;
}

let txN = 0;
const T = (date: string, description: string, lines: FxLine[], memo?: string): FxEntry => ({
  id: `90000000000000${String(++txN).padStart(5, "0")}`,
  date, description, lines, ...(memo ? { memo } : {}),
});

const twentyExpenseLines: FxLine[] = Array.from({ length: 20 }, (_, i) => ({
  account: i % 2 ? "meals" : "office",
  debit: `${10 + i}.25`,
  lineDescription: `Split line ${i + 1}`,
}));
const twentyTotal = twentyExpenseLines.reduce((s, l) => s + Math.round(Number(l.debit) * 100), 0);

export const ENTRIES: FxEntry[] = [
  /* 1  */ T("2025-01-02", "Owner investment", [{ account: "checking", debit: "10000.00" }, { account: "owner", credit: "10000.00" }]),
  /* 2  */ T("2025-01-05", "PAPER PLANET #221", [{ account: "office", debit: "123.45", vendor: "Paper Planet" }, { account: "checking", credit: "123.45", vendor: "Paper Planet" }]),
  /* 3  */ T("2025-01-06", "CLOUDWARE INC", [{ account: "software", debit: "49.00", vendor: "Cloudware Inc" }, { account: "visa", credit: "49.00", vendor: "Cloudware Inc" }]),
  /* 4  */ T("2025-01-20", "CLOUDWARE INC REFUND", [{ account: "visa", debit: "49.00", vendor: "Cloudware Inc" }, { account: "software", credit: "49.00", vendor: "Cloudware Inc" }]),
  /* 5  */ T("2025-01-10", "LEASE MASTERS JAN", [{ account: "lease", debit: "75.00", vendor: "Lease Masters" }, { account: "checking", credit: "75.00", vendor: "Lease Masters" }]),
  /* 6  */ T("2025-02-01", "Invoice 1001", [{ account: "ar", debit: "1440.00", invoice: "1001", customer: "Birch Studio" }, { account: "consulting", credit: "1440.00", invoice: "1001", customer: "Birch Studio", lineDescription: "Brand workshop" }]),
  /* 7  */ T("2025-02-15", "Payment for invoice 1001", [{ account: "checking", debit: "500.00", invoice: "1001", customer: "Birch Studio" }, { account: "ar", credit: "500.00", invoice: "1001", customer: "Birch Studio" }]),
  /* 8  */ T("2025-03-01", "Payment for invoice 1001", [{ account: "checking", debit: "940.00", invoice: "1001", customer: "Birch Studio" }, { account: "ar", credit: "940.00", invoice: "1001", customer: "Birch Studio" }]),
  /* 9  */ T("2025-02-10", "Invoice 1002", [
    { account: "ar", debit: "1082.50", invoice: "1002", customer: "Cedar & Co" },
    { account: "sales", credit: "1000.00", invoice: "1002", customer: "Cedar & Co", lineDescription: "Logo package", taxName: "State Sales Tax", taxAmount: "82.50" },
    { account: "salesTax", credit: "82.50", invoice: "1002", customer: "Cedar & Co", taxName: "State Sales Tax", taxAmount: "82.50" },
  ]),
  /* 10 */ T("2025-03-10", "Payment for invoice 1002", [{ account: "checking", debit: "500.00", invoice: "1002", customer: "Cedar & Co" }, { account: "ar", credit: "500.00", invoice: "1002", customer: "Cedar & Co" }]),
  /* 11 */ T("2025-03-15", "Invoice 1003", [{ account: "ar", debit: "1960.00", invoice: "1003", customer: "Birch Studio" }, { account: "consulting", credit: "1960.00", invoice: "1003", customer: "Birch Studio" }]),
  /* 12 */ T("2025-03-16", "Invoice 1004", [{ account: "ar", debit: "750.00", invoice: "1004", customer: "Birch Studio" }, { account: "sales", credit: "750.00", invoice: "1004", customer: "Birch Studio" }]),
  /* 13 */ T("2025-04-01", "Payment for invoices 1003, 1004", [
    { account: "checking", debit: "2710.00", customer: "Birch Studio" },
    { account: "ar", credit: "1960.00", invoice: "1003", customer: "Birch Studio" },
    { account: "ar", credit: "750.00", invoice: "1004", customer: "Birch Studio" },
  ]),
  /* 14 */ T("2025-04-05", "Invoice 1005", [
    { account: "ar", debit: "900.00", invoice: "1005", customer: "Cedar & Co" },
    { account: "sales", credit: "1000.00", invoice: "1005", customer: "Cedar & Co" },
    { account: "discount", debit: "100.00", invoice: "1005", customer: "Cedar & Co", lineDescription: "Loyalty discount" },
  ]),
  /* 15 */ T("2025-04-20", "Payment for invoice 1005", [
    { account: "checking", debit: "873.60", invoice: "1005", customer: "Cedar & Co" },
    { account: "fees", debit: "26.40", invoice: "1005", customer: "Cedar & Co" },
    { account: "ar", credit: "900.00", invoice: "1005", customer: "Cedar & Co" },
  ]),
  /* 16 */ T("2025-05-01", "Move to savings", [{ account: "checking", credit: "1800.00" }, { account: "savings", debit: "1800.00" }]),
  /* 17 */ T("2025-05-15", "ONLINE TRANSFER TO SAVINGS", [{ account: "checking", credit: "300.00" }, { account: "tc", debit: "300.00" }]),
  /* 18 */ T("2025-05-15", "ONLINE TRANSFER FROM CHECKING", [{ account: "savings", debit: "300.00" }, { account: "tc", credit: "300.00" }]),
  /* 19 */ T("2025-05-20", "VISA PAYMENT", [{ account: "checking", credit: "450.00" }, { account: "tc", debit: "450.00" }]),
  /* 20 */ T("2025-05-21", "PAYMENT THANK YOU", [{ account: "visa", debit: "450.00" }, { account: "tc", credit: "450.00" }]),
  /* 21 */ T("2025-06-01", "TRANSFER OUT 5521", [{ account: "checking", credit: "99.00" }, { account: "tc", debit: "99.00" }]),
  /* 22 */ T("2025-06-05", "Cash sale", [{ account: "checking", debit: "250.00", customer: "Walk-in Customer" }, { account: "sales", credit: "250.00", customer: "Walk-in Customer" }]),
  /* 23 */ T("2025-06-30", "INTEREST PAID", [{ account: "checking", debit: "4.12" }, { account: "otherIncome", credit: "4.12" }]),
  /* 24 */ T("2025-07-01", "Bill B-77", [{ account: "printing", debit: "600.00", bill: "B-77", vendor: "Granite Print Co" }, { account: "ap", credit: "600.00", bill: "B-77", vendor: "Granite Print Co" }]),
  /* 25 */ T("2025-07-15", "Payment for bill B-77", [{ account: "ap", debit: "400.00", bill: "B-77", vendor: "Granite Print Co" }, { account: "checking", credit: "400.00", bill: "B-77", vendor: "Granite Print Co" }]),
  /* 26 */ T("2025-08-01", "TEAM OFFSITE SPLIT", [...twentyExpenseLines, { account: "checking", credit: (twentyTotal / 100).toFixed(2) }]),
  /* 27 */ T("2025-12-31", "Year-end adjustment", [
    { account: "depreciation", debit: "300.00" }, { account: "equipment", credit: "200.00" }, { account: "prepaid", credit: "100.00" },
  ], "Depreciation and prepaid release"),
  /* 28 */ T("2025-09-01", "Customer credit", [{ account: "sales", debit: "50.00", customer: "Cedar & Co" }, { account: "ar", credit: "50.00", customer: "Cedar & Co" }]),
  /* 29 */ T("2025-09-10", "PAPER PLANET RETURN", [{ account: "visa", debit: "30.00", vendor: "Paper Planet" }, { account: "office", credit: "30.00", vendor: "Paper Planet" }]),
  /* 30 */ T("2025-09-12", "CORNER COFFEE", [{ account: "meals", debit: "8.50", vendor: "Corner Coffee" }, { account: "visa", credit: "8.50", vendor: "Corner Coffee" }]),
  /* 31 */ T("2025-09-12", "CORNER COFFEE", [{ account: "meals", debit: "12.75", vendor: "Corner Coffee" }, { account: "visa", credit: "12.75", vendor: "Corner Coffee" }]),
  /* 32 */ T("2025-09-20", "VOIDED CHARGE", [{ account: "meals", debit: "0.00" }, { account: "visa", credit: "0.00" }]),
  /* 33 */ T("2025-01-01", "Equipment purchase", [{ account: "equipment", debit: "1200.00" }, { account: "prepaid", debit: "250.00" }, { account: "checking", credit: "1450.00" }]),
];

const entryById = (id: string) => ENTRIES.find((e) => e.id === id)!;

/** Index (1-based) → entry, matching the comments above. */
export const E = (n: number) => ENTRIES[n - 1]!;

// ---- invoices (API side) -----------------------------------------------------

export interface FxInvoice {
  waveId: string;
  number: string;
  date: string;
  dueDate: string;
  status: string;
  customer: string;
  items: { description: string; account: string; quantity: string; unitPrice: string; total: string; tax?: string }[];
  discount?: string;
  payments: { waveId: string; date: string; amount: string; ledgerEntry?: FxEntry; method: string }[];
}

let invN = 0, payN = 0;
const I = (number: string, date: string, dueDate: string, status: string, customer: string, items: FxInvoice["items"], payments: Omit<FxInvoice["payments"][number], "waveId">[], discount?: string): FxInvoice => ({
  waveId: gid("Invoice", ++invN), number, date, dueDate, status, customer, items,
  payments: payments.map((p) => ({ ...p, waveId: gid("InvoicePayment", ++payN) })), ...(discount ? { discount } : {}),
});

export const INVOICES: FxInvoice[] = [
  I("1001", "2025-02-01", "2025-03-03", "PAID", "Birch Studio", [{ description: "Brand workshop", account: "consulting", quantity: "12", unitPrice: "120", total: "1440.00" }], [
    { date: "2025-02-15", amount: "500", ledgerEntry: E(7), method: "BANK_TRANSFER" },
    { date: "2025-03-01", amount: "940", method: "CHEQUE" }, // Wave gives no accountingTransactionId: fallback match
  ]),
  I("1002", "2025-02-10", "2025-03-12", "PARTIAL", "Cedar & Co", [{ description: "Logo package", account: "sales", quantity: "1", unitPrice: "1000", total: "1000.00", tax: "82.50" }], [
    { date: "2025-03-10", amount: "500", ledgerEntry: E(10), method: "BANK_TRANSFER" },
  ]),
  I("1003", "2025-03-15", "2025-04-14", "PAID", "Birch Studio", [{ description: "Website build", account: "consulting", quantity: "16", unitPrice: "122.50", total: "1960.00" }], [
    { date: "2025-04-01", amount: "1960", ledgerEntry: E(13), method: "BANK_TRANSFER" },
  ]),
  I("1004", "2025-03-16", "2025-04-15", "PAID", "Birch Studio", [{ description: "Print run", account: "sales", quantity: "3", unitPrice: "250", total: "750.00" }], [
    { date: "2025-04-01", amount: "750", ledgerEntry: E(13), method: "BANK_TRANSFER" },
  ]),
  I("1005", "2025-04-05", "2025-05-05", "PAID", "Cedar & Co", [{ description: "Annual retainer", account: "sales", quantity: "1", unitPrice: "1000", total: "1000.00" }], [
    { date: "2025-04-20", amount: "900", ledgerEntry: E(15), method: "CREDIT_CARD" },
  ], "100.00"),
  I("1006", "2025-10-01", "2025-10-31", "DRAFT", "Dogwood Partners", [{ description: "Proposal", account: "consulting", quantity: "1", unitPrice: "300", total: "300.00" }], []),
];

// ---- receipts ----------------------------------------------------------------

export const RECEIPTS: { name: string; content: string }[] = [
  { name: "2025-01-05-PAPER_PLANET_#221.pdf", content: "%PDF-1.4 synthetic receipt A" }, // unique
  { name: "2025-09-12-CORNER_COFFEE.jpg", content: "synthetic receipt B" }, // two same-day matches
  { name: "2025-09-30-UNKNOWN_SHOP.png", content: "synthetic receipt C" }, // no match
];

// ---- export writers ------------------------------------------------------------

const LEDGER_HEADERS = [
  "Transaction ID", "Transaction Date", "Account Name", "Transaction Description", "Transaction Line Description",
  "Amount (One column)", " ", "Debit Amount (Two Column Approach)", "Credit Amount (Two Column Approach)",
  "Other Accounts for this Transaction", "Customer", "Vendor", "Invoice Number", "Bill Number", "Notes / Memo",
  "Amount Before Sales Tax", "Sales Tax Amount", "Sales Tax Name", "Transaction Date Added",
  "Transaction Date Last Modified", "Account Group", "Account Type", "Account ID",
];

const GROUP: Record<FxAccount["type"], string> = { ASSET: "Asset", LIABILITY: "Liability", EQUITY: "Equity", INCOME: "Income", EXPENSE: "Expense" };

/** The account a line really posts to (for duplicate names). */
export const postingAccount = (key: string) => acct(POSTS_TO[key] ?? key);

function cents(s: string | undefined): number {
  return s ? Math.round(Number(s) * 100) : 0;
}
const fmt = (c: number) => (c < 0 ? "-" : "") + (Math.abs(c) / 100).toFixed(2);

export function accountingCsv(entries: FxEntry[] = ENTRIES): string {
  const rows: string[][] = [LEDGER_HEADERS];
  for (const e of entries) {
    const names = e.lines.map((l) => postingAccount(l.account).name);
    e.lines.forEach((l, i) => {
      const a = postingAccount(l.account);
      const dr = cents(l.debit), cr = cents(l.credit);
      const one = a.type === "ASSET" || a.type === "EXPENSE" ? dr - cr : cr - dr;
      const others = [...new Set(names.filter((_, j) => j !== i))].join(", ");
      rows.push([
        e.id, e.date, a.name, e.description, l.lineDescription ?? "", fmt(one), "",
        l.debit !== undefined ? l.debit : "", l.credit !== undefined ? l.credit : "",
        others, l.customer ?? "", l.vendor ?? "", l.invoice ?? "", l.bill ?? "", e.memo ?? "",
        l.taxAmount ? fmt(one - cents(l.taxAmount)) : fmt(one), l.taxAmount ?? "", l.taxName ?? "",
        e.date, e.date, GROUP[a.type], a.exportType, "",
      ]);
    });
  }
  return toCsv(rows);
}

export function customersCsv(): string {
  const h = ["customer_name", "email", "contact_first_name", "contact_last_name", "customer_currency", "account_number", "phone", "fax", "mobile", "toll_free", "website", "country", "province/state", "address_line_1", "address_line_2", "city", "postal_code/zip_code", "shipping_address", "ship-to_contact", "ship-to_country", "ship-to_province/state", "ship-to_address_line_1", "ship-to_address_line_2", "ship-to_city", "ship-to_postal_code/zip_code", "ship-to_phone", "delivery_instructions"];
  const rows = CUSTOMERS.slice(0, 3).map((c) => h.map((k) => (k === "customer_name" ? c.name : k === "email" ? c.email : k === "customer_currency" ? "USD" : k === "city" && c.name === "Birch Studio" ? "Portland" : "")));
  return toCsv([h, ...rows]);
}

export function vendorsCsv(): string {
  const h = ["vendor_name", "email", "contact_first_name", "contact_last_name", "vendor_currency", "account_number", "phone", "fax", "mobile", "toll_free", "website", "country", "province/state", "address_line_1", "address_line_2", "city", "postal_code/zip_code"];
  return toCsv([h, ...VENDORS.map((v) => h.map((k) => (k === "vendor_name" ? v.name : k === "vendor_currency" ? "USD" : "")))]);
}

export function billItemsCsv(): string {
  const h = ["vendor", "description", "invoice_num", "po_so", "account", "product", "amount", "quantity", "bill_date", "currency", "due_date", "taxes"];
  return toCsv([h, ["Granite Print Co", "Brochures", "B-77", "", "Printing", "", "600.00", "1", "2025-07-01", "USD", "2025-07-31", ""]]);
}

function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replaceAll('"', '""')}"` : c)).join(",")).join("\n") + "\n";
}

const ZIP_TIME = new Date(2026, 0, 15, 12, 0, 0); // 2026-01-15 12:00 local

export function transactionsZip(opts: { entries?: FxEntry[]; omit?: string[]; ledgerCsv?: string } = {}): Uint8Array {
  const files: Record<string, string> = {
    "accounting.csv": opts.ledgerCsv ?? accountingCsv(opts.entries),
    "customers.csv": customersCsv(),
    "vendors.csv": vendorsCsv(),
    "bill_items.csv": billItemsCsv(),
  };
  for (const o of opts.omit ?? []) delete files[o];
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [strToU8(v), { mtime: ZIP_TIME }]])));
}

export function receiptsZip(): Uint8Array {
  return zipSync(Object.fromEntries(RECEIPTS.map((r) => [r.name, [strToU8(r.content), { mtime: ZIP_TIME }]])));
}

// ---- fake Wave API -------------------------------------------------------------

/** Ledger balance per Wave account ID, normal-balance sign, in cents. */
export function waveBalances(entries: FxEntry[] = ENTRIES): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entries) for (const l of e.lines) {
    const a = postingAccount(l.account);
    const dr = cents(l.debit), cr = cents(l.credit);
    m.set(a.waveId, (m.get(a.waveId) ?? 0) + (a.type === "ASSET" || a.type === "EXPENSE" ? dr - cr : cr - dr));
  }
  return m;
}

/** Wave's `Money` object: `value` with thousands separators, `minorUnitValue` in cents. */
function money(c: number) {
  const s = (Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return { value: (c < 0 ? "-" : "") + s, minorUnitValue: String(c) };
}

/** Wave's bare-decimal balance format: no trailing zeros ("0", "12.5"). */
const bare = (c: number) => String(c / 100);

const ADDRESS = { addressLine1: "", addressLine2: "", city: "", postalCode: "", province: null, country: null };

export interface FakeApiOptions {
  balanceOverrides?: Record<string, string>;
  /** Responses fail with this HTTP status for the first N calls. */
  failFirst?: { status: number; times: number };
  /** Rejects tokens other than this one with 401. */
  validToken?: string;
  pageSize?: number;
}

export function fakeWaveApi(opts: FakeApiOptions = {}): { fetch: Fetch; calls: { operation: string; variables: Record<string, unknown> }[] } {
  const calls: { operation: string; variables: Record<string, unknown> }[] = [];
  const balances = waveBalances();
  let failures = opts.failFirst?.times ?? 0;
  const pageSize = opts.pageSize;

  const page = <T>(all: T[], p: number, size: number) => {
    const s = pageSize ?? size;
    const totalPages = Math.max(1, Math.ceil(all.length / s));
    return { pageInfo: { totalPages: all.length ? totalPages : 0, totalCount: all.length }, edges: all.slice((p - 1) * s, p * s).map((node) => ({ node })) };
  };

  const accountNode = (a: FxAccount) => ({
    id: a.waveId, name: a.name, description: "", displayId: null, isArchived: !!a.archived,
    balance: opts.balanceOverrides?.[a.key] ?? bare(balances.get(a.waveId) ?? 0),
    balanceInBusinessCurrency: opts.balanceOverrides?.[a.key] ?? bare(balances.get(a.waveId) ?? 0),
    normalBalanceType: a.type === "ASSET" || a.type === "EXPENSE" ? "DEBIT" : "CREDIT",
    currency: { code: "USD" }, type: { value: a.type }, subtype: { value: a.subtype, name: a.nodeSubtypeName },
  });

  const customerNode = (c: (typeof CUSTOMERS)[number]) => ({
    id: c.waveId, name: c.name, firstName: "", lastName: "", displayId: null, email: c.email, mobile: "", phone: "", fax: "", tollFree: "", website: "",
    currency: { code: "USD" }, isArchived: false, address: { ...ADDRESS, city: c.name === "Birch Studio" ? "Portland" : "" }, shippingDetails: null,
  });
  const vendorNode = (v: (typeof VENDORS)[number]) => ({
    id: v.waveId, name: v.name, firstName: "", lastName: "", displayId: null, email: "", mobile: "", phone: "", fax: "", tollFree: "", website: "",
    currency: { code: "USD" }, isArchived: false, address: null,
  });
  const invoiceNode = (inv: FxInvoice) => {
    const sub = inv.items.reduce((s, i) => s + cents(i.total), 0);
    const tax = inv.items.reduce((s, i) => s + cents(i.tax), 0);
    const disc = cents(inv.discount);
    const total = sub + tax - disc;
    const paid = inv.payments.reduce((s, p) => s + cents(p.amount), 0);
    const cust = CUSTOMERS.find((c) => c.name === inv.customer)!;
    return {
      id: inv.waveId, invoiceNumber: inv.number, invoiceDate: inv.date, dueDate: inv.dueDate, status: inv.status,
      title: "Invoice", poNumber: "", memo: "", exchangeRate: "1", createdAt: `${inv.date}T12:00:00Z`, modifiedAt: `${inv.date}T12:00:00Z`,
      currency: { code: "USD", exponent: 2 }, customer: { id: cust.waveId, name: cust.name },
      subtotal: money(sub), taxTotal: money(tax), discountTotal: money(disc), total: money(total), amountPaid: money(paid), amountDue: money(total - paid),
      items: inv.items.map((i) => ({
        description: i.description, quantity: i.quantity, unitPrice: i.unitPrice, subtotal: money(cents(i.total)), total: money(cents(i.total)),
        account: { id: acct(i.account).waveId }, product: { id: gid("Product", 1) },
        taxes: i.tax ? [{ salesTax: { id: gid("SalesTax", 1) }, amount: money(cents(i.tax)) }] : [],
      })),
      payments: inv.payments.map((p) => ({
        id: p.waveId, paymentDate: p.date, amount: p.amount, paymentMethod: p.method, active: true, memo: "",
        accountingTransactionId: p.ledgerEntry ? b64(`Business:${BUSINESS_UUID};Transaction:${p.ledgerEntry.id}`) : null,
        account: { id: acct("checking").waveId },
      })),
      attachments: [],
    };
  };

  const subtypes = [...new Map(ACCOUNTS.map((a) => [`${a.type}|${a.subtype}`, a])).values()].map((a) => ({
    name: a.exportType, value: a.subtype, systemCreated: ["RECEIVABLE_INVOICES", "RECEIVABLE_OTHER", "TRANSFERS", "PAYABLE_BILLS", "SALES_TAX"].includes(a.subtype),
    archivable: true, type: { value: a.type },
  }));

  const fetch: Fetch = async (_url, init) => {
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, any> };
    const operation = /query\s+(\w+)/.exec(query)?.[1] ?? "";
    calls.push({ operation, variables });
    const reply = (status: number, body: unknown) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
    if (failures > 0) {
      failures--;
      return reply(opts.failFirst!.status, { message: "simulated" });
    }
    if (opts.validToken && init.headers.Authorization !== `Bearer ${opts.validToken}`) return reply(401, { error: "invalid token" });
    const p = variables.page ?? 1;
    const biz = (d: unknown) => reply(200, { data: { business: d } });
    switch (operation) {
      case "WhoAmI": return reply(200, { data: { user: { id: gid("User", 1), defaultEmail: "owner@maple-pine.example", firstName: "Sam", lastName: "Maple" } } });
      case "Businesses": return reply(200, { data: { businesses: page([{ id: BUSINESS_ID, name: "Maple & Pine Design LLC", isPersonal: false, isArchived: false, currency: { code: "USD" } }], p, 50) } });
      case "Business": return reply(200, { data: {
        business: { id: BUSINESS_ID, name: "Maple & Pine Design LLC", isPersonal: false, isArchived: false, timezone: "America/Los_Angeles", createdAt: "2024-12-01T00:00:00Z", modifiedAt: "2025-10-01T00:00:00Z", currency: { code: "USD", symbol: "$", exponent: 2 }, address: ADDRESS },
        accountSubtypes: subtypes,
      } });
      case "Accounts": return biz({ accounts: page(ACCOUNTS.filter((a) => !!a.archived === variables.archived).map(accountNode), p, 200) });
      case "Customers": return biz({ customers: page(CUSTOMERS.map(customerNode), p, 200) });
      case "Vendors": return biz({ vendors: page(VENDORS.map(vendorNode), p, 200) });
      case "Products": return biz({ products: page(variables.archived ? [] : [{ id: gid("Product", 1), name: "Services", description: "", unitPrice: "125", isSold: true, isBought: false, isArchived: false, incomeAccount: { id: acct("consulting").waveId }, expenseAccount: null, defaultSalesTaxes: [] }], p, 200) });
      case "SalesTaxes": return biz({ salesTaxes: page(variables.archived ? [] : [{ id: gid("SalesTax", 1), name: "State Sales Tax", abbreviation: "ST", description: "", taxNumber: "", isCompound: false, isRecoverable: false, isArchived: false, rates: [{ effective: "2024-01-01", rate: "0.0825" }] }], p, 200) });
      case "Invoices": return biz({ invoices: page(INVOICES.map(invoiceNode), p, 50) });
      case "Estimates": return biz({ estimates: page([], p, 50) });
      default: return reply(200, { errors: [{ message: `unexpected operation ${operation}` }] });
    }
  };
  return { fetch, calls };
}

function b64(s: string): string {
  return btoa(s);
}

export { entryById };
