import { zipSync } from "fflate";
import { formatPlain } from "../../money.ts";
import { scopedLedger, OPENING_ENTRY_ID } from "../../model/opening.ts";
import type { Account, Books, Issue } from "../../model/types.ts";
import { encodeText, safeFileName, toCsv } from "../csv.ts";
import type { OutputContext, OutputFile, OutputPlugin } from "../types.ts";
import { ofxAmount, writeOfx, type Statement, type StatementLine } from "./ofx.ts";

/**
 * Bank statement files: each bank and credit card account's history in the files
 * accounting programs take as a manual bank upload, so the history lands in the
 * new system's banking screen (bank and card reports work) rather than as
 * journals. Formats and limits, from the vendors' own help pages (read
 * 2026-10-23; see docs/bank-statement-formats.md):
 *
 * - QuickBooks Online: CSV with Date, Description, Amount (3 columns); dates
 *   dd/mm/yyyy as Intuit recommends; zeros left blank; at most 1,000 lines and
 *   350 KB per file; amounts under 12 digits. .qbo (Web Connect) is Intuit's
 *   suggested type but needs a bank ID (INTU.BID) Intuit doesn't publish.
 * - Xero: OFX recommended; CSV with one signed Amount column, no thousands
 *   separators, YYYY/MM/DD is an accepted date format, at most 100,000 rows.
 *
 * Every line keeps a stable ID (FITID = Transaction ID + line), so a file
 * uploaded twice is recognised as a duplicate where the program checks.
 */

export interface BankStatementOptions {
  /** Intuit's bank ID for .qbo/.qfx files, e.g. from a .qbo file the client's bank gave them. Without it, no .qbo/.qfx files are made. */
  intuitBid?: string;
}

const QBO_MAX_LINES = 1000;
const QBO_MAX_BYTES = 350 * 1024;
const QBO_MAX_DIGITS = 11; // "12 or more digits" are refused
const XERO_CSV_MAX_ROWS = 100_000;

export interface AccountStatement {
  account: Account;
  statement: Statement;
  /** Lines skipped because their amount is zero. */
  zeroLines: number;
  /** Balance before the first line (opening balance at the cutover, or zero). */
  openingBalance: bigint;
}

/** Each bank and card account's statement lines, following the scope setting. */
export function accountStatements(books: Books): AccountStatement[] {
  const scoped = scopedLedger(books);
  const contacts = new Map(books.contacts.map((c) => [c.id, c.name] as const));
  const out: AccountStatement[] = [];
  for (const account of books.accounts) {
    if (account.role !== "bank" && account.role !== "creditCard") continue;
    let opening = 0n;
    let zero = 0;
    const lines: StatementLine[] = [];
    for (const e of scoped.entries) {
      e.lines.forEach((l, i) => {
        if (l.accountId !== account.id) return;
        const amount = l.debit - l.credit; // money in / card payment positive, for both kinds
        if (e.id === OPENING_ENTRY_ID) {
          opening += amount;
          return;
        }
        if (amount === 0n) {
          zero++;
          return;
        }
        const payee = contacts.get(l.customerId) ?? contacts.get(l.vendorId) ?? contacts.get(e.customerId) ?? contacts.get(e.vendorId) ?? "";
        lines.push({
          fitid: `${e.id}-${i + 1}`,
          date: e.date,
          amount,
          type: e.type === "transfer" || e.type === "credit-card-payment" ? "XFER" : amount > 0n ? "CREDIT" : "DEBIT",
          name: payee || e.description,
          memo: [e.description, l.description].filter(Boolean).join(" - "),
        });
      });
    }
    if (!lines.length) continue;
    lines.sort((a, b) => a.date.localeCompare(b.date) || a.fitid.localeCompare(b.fitid));
    const balance = opening + lines.reduce((s, l) => s + l.amount, 0n);
    out.push({
      account,
      zeroLines: zero,
      openingBalance: opening,
      statement: {
        kind: account.role === "creditCard" ? "creditCard" : "bank",
        accountId: `WAVEEXIT${account.code}`,
        bankId: "000000000",
        accountType: /saving/i.test(account.name) ? "SAVINGS" : "CHECKING",
        currency: account.currency || books.business.currency,
        exponent: books.business.exponent,
        start: lines[0]!.date,
        end: lines.at(-1)!.date,
        ledgerBalance: balance,
        lines,
      },
    });
  }
  return out;
}

/** dd/mm/yyyy, Intuit's recommendation for QuickBooks CSV uploads. */
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
/** YYYY/MM/DD, one of Xero's listed formats; unambiguous, so Xero needn't ask. */
const yyyymmdd = (iso: string) => iso.replaceAll("-", "/");

/** QuickBooks reads a description that is only digits as a number; keep it text. */
const qboDescription = (s: string) => (/^[\d\s.,-]+$/.test(s) ? `Ref ${s}` : s);

export function quickBooksCsv(st: Statement): string {
  return toCsv(["Date", "Description", "Amount"], st.lines.map((l) => [ddmmyyyy(l.date), qboDescription([l.name, l.memo !== l.name ? l.memo : ""].filter(Boolean).join(" - ")), formatPlain(l.amount, st.exponent)]));
}

export function xeroCsv(st: Statement): string {
  return toCsv(["Date", "Amount", "Payee", "Description", "Reference"], st.lines.map((l) => [yyyymmdd(l.date), formatPlain(l.amount, st.exponent), l.name, l.memo, l.fitid]));
}

/** Split a statement into consecutive parts that each fit `fits`, never splitting a day across files. */
export function splitStatement(st: Statement, opening: bigint, fits: (part: Statement) => boolean): Statement[] {
  const parts: Statement[] = [];
  let i = 0;
  let running = opening;
  while (i < st.lines.length) {
    // Grow the part a day at a time while it still fits.
    let end = i;
    let best = -1;
    while (end < st.lines.length) {
      let j = end;
      while (j < st.lines.length && st.lines[j]!.date === st.lines[end]!.date) j++;
      const candidate = make(i, j);
      if (!fits(candidate)) break;
      best = j;
      end = j;
    }
    if (best < 0) best = i + 1; // a single day too big for one file: take one line at a time
    const part = make(i, best);
    parts.push(part);
    running = part.ledgerBalance;
    i = best;
  }
  return parts;

  function make(from: number, to: number): Statement {
    const lines = st.lines.slice(from, to);
    return { ...st, lines, start: lines[0]!.date, end: lines.at(-1)!.date, ledgerBalance: running + lines.reduce((s, l) => s + l.amount, 0n) };
  }
}

const fitsQuickBooks = (render: (s: Statement) => string) => (s: Statement) =>
  s.lines.length <= QBO_MAX_LINES && encodeText(render(s)).length <= QBO_MAX_BYTES;

function readme(books: Books, stmts: AccountStatement[], opts: BankStatementOptions, partCounts: Map<string, number>, created: Date): string {
  const m = (v: bigint) => formatPlain(v, books.business.exponent);
  const scope = books.settings.scope === "opening-balances"
    ? `Only transactions after the cutover date ${books.period.cutoverDate} are included. Each account's opening balance at the cutover is listed below; enter it in the new system before uploading.`
    : "The full history of each account is included.";
  return [
    `Bank statement files for ${books.business.name}`,
    `Made by Wave Exit on ${created.toISOString().slice(0, 10)}.`,
    "",
    "Each bank and credit card account's transactions, in the files accounting programs take as a manual bank upload.",
    "They arrive in the new program's banking screen to be matched or categorised. Wave's categories don't come across:",
    "categorise each one there, or set up bank rules first. Every transaction keeps an ID, so uploading the same file",
    "twice is recognised as a duplicate where the program checks (Xero does).",
    "",
    scope,
    "",
    "Before you upload: if the new program is connected to the bank, its bank feed may download the same transactions.",
    "Start the feed the day after the last date here, or match feed items instead of adding them.",
    "A transfer between two of these accounts appears in both accounts' files: record it once, as a transfer.",
    "",
    "QuickBooks Online (folder \"QuickBooks Online\")",
    "  Bank transactions > Link account > Upload from file. Choose the matching bank or credit card account (not a",
    "  sub-account). Upload the parts in order: QuickBooks takes at most 1,000 lines and 350 KB per file.",
    "  - CSV files: Date, Description, Amount. Dates are dd/mm/yyyy, as Intuit recommends. Money in is positive.",
    opts.intuitBid
      ? `  - .qbo files: Web Connect files with bank ID ${opts.intuitBid}.`
      : "  - No .qbo files: they need the bank's Intuit ID (INTU.BID), which Intuit doesn't publish. Open a .qbo file the\n    bank gave you in a text editor, find <INTU.BID>, and enter that number in Wave Exit to get .qbo files.",
    "  Intuit asks that the file start at least one day before the oldest QuickBooks transaction in that account.",
    "",
    "Xero (folder \"Xero\")",
    "  Accounting > Bank accounts > (account menu) > Import a Statement. Xero recommends the .ofx file.",
    "  The .csv file is the alternative: assign Date, Amount, Payee, Description and Reference the first time.",
    "  Dates are YYYY/MM/DD. Money in (or a card payment) is positive, money out (or a card purchase) negative.",
    "",
    "Other programs (folder \"Other programs\")",
    "  .ofx files work in most programs that import bank statements" + (opts.intuitBid ? "; .qfx files are for Quicken." : "."),
    "",
    "Accounts",
    ...stmts.map((s) => `  ${s.account.code} ${s.account.name} (${s.statement.kind === "creditCard" ? "credit card" : "bank"}): ${s.statement.lines.length} transactions, ${s.statement.start} to ${s.statement.end}, ${partCounts.get(s.account.id) ?? 1} QuickBooks part(s). Opening balance ${m(s.openingBalance)}, closing balance ${m(s.statement.ledgerBalance)} (money-in positive; for a card, a negative balance is owed).${s.zeroLines ? ` ${s.zeroLines} zero-amount line(s) left out.` : ""}`),
    "",
  ].join("\r\n");
}

export const bankStatementFiles: OutputPlugin = {
  id: "bank-statements",
  group: "import-files",
  title: "Bank statement files",
  summary: "Each bank and card account as OFX and CSV statement files for QuickBooks Online, Xero and other programs, so history lands in their banking screens.",
  describe: (books) => ({
    keeps: [
      { aspect: "bank-transactions", text: "Every bank and credit card transaction, with date, amount, payee and description, for the new program's banking screen." },
    ],
    loses: [
      { aspect: "categories", text: "Wave's categories: each transaction arrives uncategorised, to match or categorise (bank rules help)." },
      { aspect: "ledger", text: "Anything not in a bank or card account (invoices, bills, journals): load those with another output." },
      { aspect: "invoices", text: "No invoices or what they paid." },
      { aspect: "attachments", text: "No receipts." },
    ],
    withoutConnection: [],
  }),
  validate(books): Issue[] {
    const issues: Issue[] = [];
    const stmts = accountStatements(books);
    if (!stmts.length) {
      issues.push({ id: "bank-statements:none", kind: "output-limit", severity: "amber", title: "No bank or credit card transactions to export", explanation: "None of the accounts in these books is a bank or credit card account with transactions in scope, so the bank statement files would be empty.", options: [], refs: [] });
    }
    for (const s of stmts) {
      const huge = s.statement.lines.filter((l) => (l.amount < 0n ? -l.amount : l.amount).toString().length > QBO_MAX_DIGITS + s.statement.exponent);
      if (huge.length) {
        issues.push({ id: `bank-statements:too-large:${s.account.id}`, kind: "output-limit", severity: "amber", title: `${s.account.name}: ${huge.length} amount(s) too large for QuickBooks uploads`, explanation: "QuickBooks refuses uploaded transactions with 12 or more digits. Enter those by hand in QuickBooks; Xero and other programs take them.", options: [], refs: huge.map((l) => l.fitid) });
      }
      if (s.statement.lines.length > XERO_CSV_MAX_ROWS) {
        issues.push({ id: `bank-statements:xero-rows:${s.account.id}`, kind: "output-limit", severity: "amber", title: `${s.account.name}: too many rows for one Xero CSV`, explanation: `Xero takes at most ${XERO_CSV_MAX_ROWS.toLocaleString("en-US")} rows per CSV file. Use the .ofx file for Xero instead.`, options: [], refs: [] });
      }
      if (s.account.currency && s.account.currency !== books.business.currency) {
        issues.push({ id: `bank-statements:currency:${s.account.id}`, kind: "output-limit", severity: "amber", title: `${s.account.name} is in ${s.account.currency}`, explanation: `The ledger gives amounts in ${books.business.currency}, so this account's statement is in ${books.business.currency}, not ${s.account.currency}. Check before uploading it to a ${s.account.currency} account.`, options: [], refs: [] });
      }
    }
    return issues;
  },
  async produce(books, ctx: OutputContext): Promise<OutputFile[]> {
    const opts = (ctx.options?.["bank-statements"] ?? {}) as BankStatementOptions;
    const bid = opts.intuitBid?.trim() || undefined;
    const ofx = (s: Statement, intuitBid?: string) => writeOfx(s, { created: ctx.createdAt, ...(intuitBid ? { intuitBid } : {}) });
    const files: Record<string, [Uint8Array, { mtime: Date }]> = {};
    const put = (path: string, text: string) => (files[path] = [encodeText(text), { mtime: ctx.createdAt }]);
    const stmts = accountStatements(books);
    const partCounts = new Map<string, number>();
    for (const s of stmts) {
      const base = safeFileName(`${s.account.code} ${s.account.name}`);
      const st = s.statement;
      // QuickBooks Online: split to its limits.
      const csvParts = splitStatement(st, s.openingBalance, fitsQuickBooks(quickBooksCsv));
      partCounts.set(s.account.id, csvParts.length);
      const tag = (p: Statement, i: number, n: number) => (n > 1 ? ` part ${String(i + 1).padStart(2, "0")} of ${n} (${p.start} to ${p.end})` : "");
      csvParts.forEach((p, i) => put(`QuickBooks Online/${base}${tag(p, i, csvParts.length)}.csv`, quickBooksCsv(p)));
      if (bid) {
        const qboParts = splitStatement(st, s.openingBalance, fitsQuickBooks((p) => ofx(p, bid)));
        qboParts.forEach((p, i) => put(`QuickBooks Online/${base}${tag(p, i, qboParts.length)}.qbo`, ofx(p, bid)));
      }
      // Xero: whole history in one file each.
      put(`Xero/${base}.ofx`, ofx(st));
      put(`Xero/${base}.csv`, xeroCsv(st));
      // Everything else.
      put(`Other programs/${base}.ofx`, ofx(st));
      if (bid) put(`Other programs/${base}.qfx`, ofx(st, bid));
    }
    put("README.txt", readme(books, stmts, { ...(bid ? { intuitBid: bid } : {}) }, partCounts, ctx.createdAt));
    const ordered = Object.fromEntries(Object.keys(files).sort((a, b) => (a === "README.txt" ? -1 : b === "README.txt" ? 1 : a.localeCompare(b))).map((k) => [k, files[k]!]));
    return [{
      name: `${safeFileName(books.business.name)} – bank statement files – ${ctx.createdAt.toISOString().slice(0, 10)}.zip`,
      bytes: zipSync(ordered),
      mediaType: "application/zip",
    }];
  },
};

export { ofxAmount };
