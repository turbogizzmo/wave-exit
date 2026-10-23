import type { TransactionsExport } from "../readers/transactions-export.ts";
import type { WaveSnapshot } from "../readers/wave-api/snapshot.ts";
import { normalizeName } from "./names.ts";

/**
 * Nothing in Wave's export names the business, so compare it with the connected
 * business: how many of the export's account, customer and vendor names Wave's
 * lists contain. Tested on real data: the right business matched 34/34 accounts,
 * 3/3 customers and 122/122 vendors; the other two businesses on the same login
 * matched 0/3 customers and at most 1/122 vendors.
 */
export interface BusinessMatch {
  accounts: { matched: number; of: number };
  customers: { matched: number; of: number };
  vendors: { matched: number; of: number };
  /** Share of all names found, 0–1. */
  score: number;
  verdict: "same-business" | "unsure" | "different-business";
}

export function matchExportToBusiness(exp: TransactionsExport, snap: WaveSnapshot): BusinessMatch {
  const share = (names: Iterable<string>, known: Iterable<string>) => {
    const k = new Set([...known].map(normalizeName));
    const n = [...new Set([...names].filter(Boolean))];
    return { matched: n.filter((x) => k.has(normalizeName(x))).length, of: n.length };
  };
  const accounts = share(exp.ledger.map((r) => r.accountName), snap.accounts.map((a) => a.name));
  const customers = share([...exp.customers.map((c) => c.name), ...exp.ledger.map((r) => r.customer)], snap.customers.map((c) => c.name));
  const vendors = share([...exp.vendors.map((c) => c.name), ...exp.ledger.map((r) => r.vendor)], snap.vendors.map((c) => c.name));
  const matched = accounts.matched + customers.matched + vendors.matched;
  const of = accounts.of + customers.of + vendors.of;
  const score = of ? matched / of : 1;
  // Account names alone are weak evidence (every Wave chart has "Accounts Receivable"),
  // so contacts carry the verdict when there are any.
  const contactOf = customers.of + vendors.of;
  const contactScore = contactOf ? (customers.matched + vendors.matched) / contactOf : accounts.of ? accounts.matched / accounts.of : 1;
  const verdict = contactScore >= 0.8 && accounts.matched / Math.max(1, accounts.of) >= 0.8
    ? "same-business"
    : contactScore < 0.3
      ? "different-business"
      : "unsure";
  return { accounts, customers, vendors, score, verdict };
}
