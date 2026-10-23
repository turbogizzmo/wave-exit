import { sum, type Minor } from "../../money.ts";
import { trialBalance } from "../../model/ledger.ts";
import { fiscalYearStart } from "../../model/opening.ts";
import type { Account, Books } from "../../model/types.ts";

/** Financial statements computed from the ledger, for the PDF pack and the Excel summary. */

export interface FiscalYear {
  label: string;
  start: string;
  end: string;
}

export function fiscalYears(books: Books): FiscalYear[] {
  const endMonth = books.settings.fiscalYearEndMonth ?? 12;
  const { firstDate, lastDate } = books.period;
  if (!firstDate) return [];
  const years: FiscalYear[] = [];
  let start = fiscalYearStart(firstDate, endMonth);
  while (start <= lastDate) {
    const [y, m] = start.split("-").map(Number) as [number, number];
    const nextStart = `${y + 1}-${String(m).padStart(2, "0")}-01`;
    const end = new Date(Date.parse(nextStart) - 86_400_000).toISOString().slice(0, 10);
    years.push({ label: endMonth === 12 ? `${y}` : `Year ending ${end}`, start, end });
    start = nextStart;
  }
  return years;
}

export interface StatementLine {
  account: Account;
  amount: Minor;
}

export interface ProfitAndLoss {
  year: FiscalYear;
  income: StatementLine[];
  costOfSales: StatementLine[];
  expenses: StatementLine[];
  totalIncome: Minor;
  totalCostOfSales: Minor;
  grossProfit: Minor;
  totalExpenses: Minor;
  netIncome: Minor;
}

const dayBefore = (d: string) => new Date(Date.parse(d) - 86_400_000).toISOString().slice(0, 10);

/** Net movement per account between two dates (inclusive), normal-balance sign. */
function movement(books: Books, from: string, to: string): Map<string, Minor> {
  const end = new Map(trialBalance(books.entries, books.accounts, to).map((r) => [r.accountId, r.balance] as const));
  const start = new Map(trialBalance(books.entries, books.accounts, dayBefore(from)).map((r) => [r.accountId, r.balance] as const));
  return new Map(books.accounts.map((a) => [a.id, (end.get(a.id) ?? 0n) - (start.get(a.id) ?? 0n)] as const));
}

const nonZero = (lines: StatementLine[]) => lines.filter((l) => l.amount !== 0n);
const byCode = (a: StatementLine, b: StatementLine) => a.account.code.localeCompare(b.account.code, undefined, { numeric: true });

export function profitAndLoss(books: Books, year: FiscalYear): ProfitAndLoss {
  const m = movement(books, year.start, year.end);
  const line = (a: Account): StatementLine => ({ account: a, amount: m.get(a.id) ?? 0n });
  const income = nonZero(books.accounts.filter((a) => a.type === "INCOME").map(line)).sort(byCode);
  const costOfSales = nonZero(books.accounts.filter((a) => a.subtype === "COST_OF_GOODS_SOLD").map(line)).sort(byCode);
  const expenses = nonZero(books.accounts.filter((a) => a.type === "EXPENSE" && a.subtype !== "COST_OF_GOODS_SOLD").map(line)).sort(byCode);
  const totalIncome = sum(income.map((l) => l.amount));
  const totalCostOfSales = sum(costOfSales.map((l) => l.amount));
  const totalExpenses = sum(expenses.map((l) => l.amount));
  return {
    year, income, costOfSales, expenses, totalIncome, totalCostOfSales,
    grossProfit: totalIncome - totalCostOfSales, totalExpenses, netIncome: totalIncome - totalCostOfSales - totalExpenses,
  };
}

export interface BalanceSheet {
  asOf: string;
  assets: StatementLine[];
  liabilities: StatementLine[];
  equity: StatementLine[];
  /** Profit from fiscal years before the one containing asOf (Wave posts no closing entries). */
  retainedEarnings: Minor;
  /** Profit for the fiscal year to asOf. */
  currentYearEarnings: Minor;
  totalAssets: Minor;
  totalLiabilities: Minor;
  totalEquity: Minor;
}

export function balanceSheet(books: Books, asOf: string): BalanceSheet {
  const tb = new Map(trialBalance(books.entries, books.accounts, asOf).map((r) => [r.accountId, r.balance] as const));
  const line = (a: Account): StatementLine => ({ account: a, amount: tb.get(a.id) ?? 0n });
  const pick = (t: Account["type"]) => nonZero(books.accounts.filter((a) => a.type === t).map(line)).sort(byCode);
  const fyStart = fiscalYearStart(asOf, books.settings.fiscalYearEndMonth ?? 12);
  const profitTo = (d: string) => {
    const t = trialBalance(books.entries, books.accounts, d);
    const acc = new Map(books.accounts.map((a) => [a.id, a] as const));
    return sum(t.map((r) => (acc.get(r.accountId)!.type === "INCOME" ? r.balance : acc.get(r.accountId)!.type === "EXPENSE" ? -r.balance : 0n)));
  };
  const retainedEarnings = profitTo(dayBefore(fyStart));
  const currentYearEarnings = profitTo(asOf) - retainedEarnings;
  const assets = pick("ASSET");
  const liabilities = pick("LIABILITY");
  const equity = pick("EQUITY");
  return {
    asOf, assets, liabilities, equity, retainedEarnings, currentYearEarnings,
    totalAssets: sum(assets.map((l) => l.amount)),
    totalLiabilities: sum(liabilities.map((l) => l.amount)),
    totalEquity: sum(equity.map((l) => l.amount)) + retainedEarnings + currentYearEarnings,
  };
}
