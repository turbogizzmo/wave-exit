import { parseAmount } from "../money.ts";
import type { WaveSnapshot } from "../readers/wave-api/snapshot.ts";
import type { Account, Estimate, Item, TaxRate } from "./types.ts";

/**
 * Products/services, sales taxes and estimates. They come only from Wave's API;
 * in export-file-only mode they are empty (the export has none of them).
 */

/** Maps a Wave account ID to the model account it ended up in (merged system accounts included). */
export function waveAccountLookup(accounts: readonly Account[]): (waveId: string) => string {
  const m = new Map<string, string>();
  for (const a of accounts) for (const w of a.waveIds) m.set(w, a.id);
  return (waveId) => (waveId ? (m.get(waveId) ?? `wave:${waveId}`) : "");
}

export function buildCatalog(snapshot: WaveSnapshot | undefined, accountFor: (waveId: string) => string, asOf: string, exponent: number) {
  if (!snapshot) return { items: [] as Item[], taxRates: [] as TaxRate[], estimates: [] as Estimate[] };
  const items: Item[] = snapshot.products.map((p) => ({
    id: `wave:${p.id}`, name: p.name, description: p.description, unitPrice: p.unitPrice,
    isSold: p.isSold, isBought: p.isBought,
    incomeAccountId: accountFor(p.incomeAccountId), expenseAccountId: accountFor(p.expenseAccountId),
    taxRateIds: p.salesTaxIds.map((t) => `wave:${t}`), isArchived: p.isArchived,
  }));
  const taxRates: TaxRate[] = snapshot.salesTaxes.map((t) => {
    const rates = [...t.rates].sort((a, b) => a.effective.localeCompare(b.effective));
    const current = rates.filter((r) => !asOf || r.effective <= asOf).at(-1) ?? rates[0];
    return {
      id: `wave:${t.id}`, name: t.name, abbreviation: t.abbreviation, taxNumber: t.taxNumber,
      rate: current?.rate ?? "", rates, isCompound: t.isCompound, isRecoverable: t.isRecoverable, isArchived: t.isArchived,
    };
  });
  const estimates: Estimate[] = snapshot.estimates.map((e) => ({
    id: `wave:${e.id}`, number: e.number, contactId: e.customerId ? `wave:${e.customerId}` : "",
    date: e.date, expiryDate: e.dueDate, status: e.status, total: parseAmount(e.total, exponent),
    lines: e.items.map((it) => ({
      description: it.description, quantity: it.quantity, unitPrice: it.unitPrice,
      accountId: accountFor(it.accountId), itemId: it.productId ? `wave:${it.productId}` : "",
      amount: parseAmount(it.total, exponent), taxAmount: 0n, taxRateIds: [],
    })),
  }));
  const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  return {
    items: items.sort(byName),
    taxRates: taxRates.sort(byName),
    estimates: estimates.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number, undefined, { numeric: true })),
  };
}
