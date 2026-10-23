import { scopedLedger } from "../model/opening.ts";
import type { Books } from "../model/types.ts";
import { encodeText, safeFileName, toCsv } from "./csv.ts";
import { helpers } from "./package/tables.ts";
import type { OutputPlugin } from "./types.ts";

/**
 * Generic general ledger CSV: one row per line with debit and credit columns, for
 * any system that imports a journal. Follows the scope setting: full history, or
 * an opening entry at the cutover date plus everything after it.
 */

export const GL_COLUMNS = [
  "date", "entry_id", "line_no", "account_code", "account_name", "account_type", "debit", "credit",
  "description", "line_description", "contact", "entry_type", "reference", "memo",
] as const;

export function glRows(books: Books): string[][] {
  const scoped = scopedLedger(books);
  const h = helpers(books, scoped.extraAccounts);
  return scoped.entries.flatMap((e) =>
    e.lines.map((l, i) => {
      const a = h.account(l.accountId)!;
      return [
        e.date, e.id, String(i + 1), a.code, a.name, a.type, h.amt(l.debit), h.amt(l.credit), e.description, l.description,
        h.contact(l.customerId)?.name ?? h.contact(l.vendorId)?.name ?? h.contact(e.customerId)?.name ?? h.contact(e.vendorId)?.name ?? "", e.type,
        l.invoiceNumber ? `Invoice ${l.invoiceNumber}` : l.billNumber ? `Bill ${l.billNumber}` : "", l.memo,
      ];
    }),
  );
}

export const glCsv: OutputPlugin = {
  id: "gl-csv",
  group: "import-files",
  title: "General ledger CSV",
  summary: "One row per ledger line with debit and credit columns, for any accounting system that imports journals.",
  describe: (books) => ({
    keeps: [
      { aspect: "ledger", text: books.settings.scope === "opening-balances" ? `Opening balances at ${books.period.cutoverDate}, then every ledger line after it.` : "Every ledger line, debit and credit." },
      { aspect: "entry-types", text: "Each entry's type, so the receiving system can be told what it was." },
      { aspect: "chart-of-accounts", text: "Account code, name and type on every line." },
    ],
    loses: [
      { aspect: "contact-details", text: "Contact names only: no addresses or emails." },
      { aspect: "invoice-lines", text: "No invoice line items, products or quantities." },
      { aspect: "payments", text: "No payment-to-invoice links: payments are plain journal lines." },
      { aspect: "attachments", text: "No receipts." },
      { aspect: "tax-rates", text: "No sales tax rates." },
    ],
    withoutConnection: [],
  }),
  validate: () => [],
  async produce(books, ctx) {
    const name = `${safeFileName(books.business.name)} – general ledger – ${ctx.createdAt.toISOString().slice(0, 10)}.csv`;
    return [{ name, bytes: encodeText(toCsv(GL_COLUMNS, glRows(books))), mediaType: "text/csv" }];
  },
};
