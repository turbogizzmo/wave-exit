import type { Minor } from "../money.ts";
import type { Account, Entry } from "./types.ts";

export interface TrialBalanceRow {
  accountId: string;
  debit: Minor;
  credit: Minor;
  /** debit − credit for debit-normal accounts, credit − debit otherwise (Wave's sign). */
  balance: Minor;
}

/** Totals per account for entries dated on or before `asOf` (all entries when omitted). */
export function trialBalance(entries: readonly Entry[], accounts: readonly Account[], asOf?: string): TrialBalanceRow[] {
  const acc = new Map(accounts.map((a) => [a.id, a] as const));
  const rows = new Map<string, TrialBalanceRow>(accounts.map((a) => [a.id, { accountId: a.id, debit: 0n, credit: 0n, balance: 0n }]));
  for (const e of entries) {
    if (asOf && e.date > asOf) continue;
    for (const l of e.lines) {
      const r = rows.get(l.accountId)!;
      r.debit += l.debit;
      r.credit += l.credit;
    }
  }
  for (const r of rows.values()) {
    r.balance = acc.get(r.accountId)!.normalBalance === "DEBIT" ? r.debit - r.credit : r.credit - r.debit;
  }
  return [...rows.values()];
}
