import { sum, type Minor } from "../money.ts";
import { trialBalance } from "./ledger.ts";
import type { Account, Books, Entry } from "./types.ts";

/**
 * The ledger as an output should carry it, given the scope setting.
 *
 * - **Full history**: every entry.
 * - **Opening balances at the cutover date**: one opening entry dated the cutover
 *   date, then every entry after it. The opening entry carries:
 *   - balance-sheet accounts at their cutover balance, except accounts receivable
 *     and payable, which arrive as the individual open invoices and bills instead
 *     (so they aren't counted twice);
 *   - income and expense accounts at their balance for the fiscal year so far, so
 *     the new system's year-to-date reports are right;
 *   - profit from earlier fiscal years in retained earnings;
 *   - the receivable/payable amount left out, in an Opening Balance Equity line.
 *     Importing the open invoices and bills against Opening Balance Equity clears it.
 */

export const OPENING_ENTRY_ID = "opening-balance";
export const RETAINED_EARNINGS_ID = "wave-exit:retained-earnings";
export const OPENING_EQUITY_ID = "wave-exit:opening-balance-equity";

export interface ScopedLedger {
  entries: Entry[];
  /** Accounts the opening entry needs that aren't in Wave's chart. */
  extraAccounts: Account[];
  scope: Books["settings"]["scope"];
}

/** First day of the fiscal year containing `date`. */
export function fiscalYearStart(date: string, endMonth = 12): string {
  const [y, m] = date.split("-").map(Number) as [number, number];
  const startMonth = (endMonth % 12) + 1;
  return `${m >= startMonth ? y : y - 1}-${String(startMonth).padStart(2, "0")}-01`;
}

export function scopedLedger(books: Books): ScopedLedger {
  if (books.settings.scope !== "opening-balances") return { entries: books.entries, extraAccounts: [], scope: "full-history" };
  const cutover = books.period.cutoverDate;
  const fyStart = fiscalYearStart(cutover, books.settings.fiscalYearEndMonth ?? 12);
  const dayBefore = (d: string) => new Date(Date.parse(d) - 86_400_000).toISOString().slice(0, 10);

  const atCutover = new Map(trialBalance(books.entries, books.accounts, cutover).map((r) => [r.accountId, r] as const));
  const beforeYear = new Map(trialBalance(books.entries, books.accounts, dayBefore(fyStart)).map((r) => [r.accountId, r] as const));
  const lines: Entry["lines"] = [];
  const extraAccounts: Account[] = [];
  const add = (accountId: string, net: Minor, description: string) => {
    if (net === 0n) return;
    lines.push({
      row: 0, accountId, debit: net > 0n ? net : 0n, credit: net < 0n ? -net : 0n, description,
      customerId: "", vendorId: "", invoiceNumber: "", billNumber: "", memo: "", salesTaxName: "", salesTaxAmount: "",
    });
  };

  const taken = new Set(books.accounts.map((a) => a.code));
  const freeCode = () => {
    let n = 3900;
    while (taken.has(String(n))) n += 10;
    taken.add(String(n));
    return String(n);
  };

  let priorProfit = 0n; // credit-positive
  let leftOut = 0n; // debit-positive
  for (const a of books.accounts) {
    const c = atCutover.get(a.id)!;
    const net = c.debit - c.credit;
    if (a.type === "INCOME" || a.type === "EXPENSE") {
      const p = beforeYear.get(a.id)!;
      const prior = p.debit - p.credit;
      priorProfit -= prior;
      add(a.id, net - prior, "Fiscal year to date");
    } else if (a.role === "receivable" || a.role === "payable") {
      leftOut += net;
    } else {
      add(a.id, net, "Balance at cutover");
    }
  }

  const retained = books.accounts.find((a) => a.subtype === "RETAINED_EARNINGS");
  if (priorProfit !== 0n) {
    const id = retained?.id ?? RETAINED_EARNINGS_ID;
    if (!retained) extraAccounts.push(syntheticEquity(RETAINED_EARNINGS_ID, "Retained Earnings", "RETAINED_EARNINGS", freeCode()));
    add(id, -priorProfit, "Profit from earlier fiscal years");
  }
  if (leftOut !== 0n) {
    extraAccounts.push(syntheticEquity(OPENING_EQUITY_ID, "Opening Balance Equity", "NON_RETAINED_EARNINGS", freeCode()));
    add(OPENING_EQUITY_ID, leftOut, "Receivables and payables, carried as open invoices and bills");
  }

  const opening: Entry = {
    id: OPENING_ENTRY_ID, date: cutover, description: `Opening balances at ${cutover}`, memo: "", lines,
    customerId: "", vendorId: "", invoiceNumbers: [], billNumbers: [], dateAdded: "", dateModified: "",
    debitTotal: sum(lines.map((l) => l.debit)), creditTotal: sum(lines.map((l) => l.credit)),
    type: "journal", ruleId: "opening-balance",
    why: "Opening balances at the cutover date, made by Wave Exit from the full history.", attachments: [],
  };
  return { entries: [opening, ...books.entries.filter((e) => e.date > cutover)], extraAccounts, scope: "opening-balances" };
}

function syntheticEquity(id: string, name: string, subtype: string, code: string): Account {
  return {
    id, code, name, group: "Equity", type: "EQUITY", subtype, subtypeName: name,
    normalBalance: "CREDIT", role: "equity", displayId: "", description: "Added by Wave Exit for the opening balances.",
    currency: "", isArchived: false, isSystem: false, waveIds: [], lineCount: 0,
  };
}
