import type { ReceiptsExport } from "../readers/receipts-export.ts";
import type { TransactionsExport } from "../readers/transactions-export.ts";
import type { WaveSnapshot } from "../readers/wave-api/snapshot.ts";
import { resolveAccounts } from "./accounts.ts";
import { runChecks } from "./checks.ts";
import { resolveContacts } from "./contacts.ts";
import { buildEntries, classifyEntries, pairTransferLegs } from "./entries.ts";
import { matchExportToBusiness } from "./identity.ts";
import { agingAt, buildOpenItems } from "./open-items.ts";
import { linkReceipts } from "./receipts.ts";
import { DEFAULT_RULES } from "./rules.ts";
import type { Books, Issue, Settings } from "./types.ts";

export interface BuildInputs {
  transactions: TransactionsExport;
  /** From the Wave connection. Absent = export-file-only mode. */
  wave?: WaveSnapshot;
  receipts?: ReceiptsExport;
  settings?: Partial<Settings>;
  /** Needed only in export-file-only mode, where nothing names the business. */
  business?: { name: string; currency: string; exponent?: number };
  /** For "dated after the export" when the ZIP carries no time. ISO date. */
  today?: string;
}

/**
 * Build the merged, checked books from whatever inputs a project has. Pure and
 * deterministic: the same inputs and settings always give the same model, so it can
 * re-run on every change and stored Review answers keep applying.
 */
export function buildBooks(input: BuildInputs): Books {
  const { transactions: tx, wave, receipts } = input;
  const settings: Settings = {
    scope: input.settings?.scope ?? "full-history",
    resolutions: input.settings?.resolutions ?? {},
    ...(input.settings?.cutoverDate ? { cutoverDate: input.settings.cutoverDate } : {}),
    ...(input.settings?.rules ? { rules: input.settings.rules } : {}),
  };
  const rules = settings.rules ?? [...DEFAULT_RULES];
  const exponent = wave?.business.currency.exponent ?? input.business?.exponent ?? 2;
  const currency = wave?.business.currency.code ?? input.business?.currency ?? "";
  const mode = wave ? "connected" : "export-file-only";

  const acct = resolveAccounts(tx.ledger, wave, settings.resolutions, exponent);
  const accounts = new Map(acct.accounts.map((a) => [a.id, a] as const));
  const contacts = resolveContacts(tx.ledger, tx.customers, tx.vendors, wave);

  const entries = buildEntries(tx.ledger, acct.byExportKey, contacts.byName);
  classifyEntries(entries, accounts, rules);
  const transferIssues = pairTransferLegs(entries, accounts, settings.resolutions, exponent);

  const open = buildOpenItems(entries, accounts, wave, exponent);
  const receiptLinks = receipts ? linkReceipts(receipts.receipts, entries, settings.resolutions) : { links: [], issues: [] };

  const firstDate = entries[0]?.date ?? "";
  const lastDate = entries.at(-1)?.date ?? "";
  const cutoverDate = settings.cutoverDate ?? lastDate;
  const exportDate = tx.exportedAt?.toISOString().slice(0, 10) ?? wave?.fetchedAt.slice(0, 10) ?? input.today ?? new Date().toISOString().slice(0, 10);

  const preIssues: Issue[] = [...acct.issues, ...transferIssues, ...open.issues, ...receiptLinks.issues];
  const checked = runChecks({
    mode,
    exponent,
    businessCurrency: currency,
    accounts: acct.accounts,
    entries,
    invoices: open.invoices,
    bills: open.bills,
    receipts: receiptLinks.links,
    issues: preIssues,
    rowCounts: {
      ledgerRows: tx.ledger.length,
      exportCustomers: tx.customers.length,
      exportVendors: tx.vendors.length,
      receiptFiles: receipts?.receipts.length ?? 0,
    },
    exportDate,
    lastModified: tx.summary.lastModified,
    ...(wave ? { waveInvoiceCount: wave.invoices.filter((i) => i.status !== "DRAFT" && i.status !== "SAVED").length } : {}),
    ...(wave ? { businessMatch: matchExportToBusiness(tx, wave) } : {}),
    resolutions: settings.resolutions,
  });

  const issues = [...checked.issues, ...preIssues].map((i) =>
    settings.resolutions[i.id] ? { ...i, resolution: settings.resolutions[i.id]! } : i,
  );

  return {
    mode,
    business: { name: wave?.business.name ?? input.business?.name ?? "", waveId: wave?.business.id ?? "", currency, exponent },
    period: { firstDate, lastDate, cutoverDate },
    ...(tx.exportedAt ? { exportedAt: tx.exportedAt.toISOString() } : {}),
    ...(wave ? { waveFetchedAt: wave.fetchedAt } : {}),
    accounts: acct.accounts,
    contacts: contacts.contacts,
    entries,
    invoices: open.invoices,
    bills: open.bills,
    payments: open.payments,
    agingAr: agingAt(open.invoices, cutoverDate),
    agingAp: agingAt(open.bills, cutoverDate),
    receipts: receiptLinks.links,
    issues,
    checks: checked.checks,
    notes: [...tx.notes, ...(receipts?.notes ?? [])],
    sources: tx.files,
    settings,
    rules,
  };
}

/** Red items that still need an answer. Outputs stay disabled while any remain. */
export function blockingItems(books: Books): { issues: Issue[]; checks: Books["checks"] } {
  return {
    issues: books.issues.filter((i) => i.severity === "red" && !i.resolution),
    checks: books.checks.filter((c) => c.status === "red"),
  };
}
