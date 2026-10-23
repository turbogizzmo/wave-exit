import { formatPlain, type Minor } from "../../money.ts";
import { trialBalance } from "../../model/ledger.ts";
import type { Account, Books, Contact, DocumentLine, OpenDocument } from "../../model/types.ts";

/**
 * The universal package's tables. Each definition is the single source for the
 * CSV file, the column documentation in README.html, and the Excel sheet of the
 * same name, so the published spec can't drift from what is written.
 */

export type ColumnKind = "id" | "text" | "date" | "amount" | "decimal" | "integer" | "boolean" | "list" | "json" | "code";

export interface ColumnSpec {
  name: string;
  kind: ColumnKind;
  doc: string;
}

export interface TableSpec {
  file: string;
  /** Sheet name in the Excel workbook (≤ 31 characters). */
  sheet: string;
  doc: string;
  columns: ColumnSpec[];
  rows(books: Books): string[][];
}

const C = (name: string, kind: ColumnKind, doc: string): ColumnSpec => ({ name, kind, doc });

export const KIND_DOC: Record<ColumnKind, string> = {
  id: "Stable identifier. Survives re-running Wave Exit on a newer export. `wave:` IDs are Wave's own; `export:` IDs come from names in the export.",
  code: "Chart code. Wave's account number where set, otherwise assigned by Wave Exit by type (1000s assets, 2000s liabilities, 3000s equity, 4000s income, 5000s expenses).",
  text: "Text.",
  date: "Date, YYYY-MM-DD. Blank if unknown.",
  amount: "Money in the business currency: plain decimal, `.` as decimal point, no thousands separators or symbol, minus sign for negatives.",
  decimal: "Plain decimal number, as Wave gives it.",
  integer: "Whole number.",
  boolean: "`true` or `false`.",
  list: "A JSON array of strings, e.g. `[\"a\",\"b\"]`. `[]` when empty.",
  json: "A JSON object. `{}` when empty.",
};

export interface Helpers {
  amt(v: Minor): string;
  opt(v: Minor | undefined): string;
  bool(v: boolean): string;
  list(v: readonly string[]): string;
  account(id: string): Account | undefined;
  contact(id: string): Contact | undefined;
}

export function helpers(books: Books, extraAccounts: readonly Account[] = []): Helpers {
  const acc = new Map([...books.accounts, ...extraAccounts].map((a) => [a.id, a] as const));
  const con = new Map(books.contacts.map((c) => [c.id, c] as const));
  const amt = (v: Minor) => formatPlain(v, books.business.exponent);
  return {
    amt,
    opt: (v) => (v === undefined ? "" : amt(v)),
    bool: (v) => (v ? "true" : "false"),
    list: (v) => JSON.stringify(v),
    account: (id) => acc.get(id),
    contact: (id) => con.get(id),
  };
}

const docColumns = (kind: "invoice" | "bill"): ColumnSpec[] => {
  const who = kind === "invoice" ? "customer" : "vendor";
  return [
    C(`${kind}_id`, "id", `The ${kind}.`),
    C("number", "text", `${kind === "invoice" ? "Invoice" : "Bill"} number.`),
    C(`${who}_id`, "id", `The ${who} (contacts.csv).`),
    C(`${who}_name`, "text", `The ${who}'s name.`),
    C("date", "date", `${kind === "invoice" ? "Invoice" : "Bill"} date.`),
    C("due_date", "date", "Due date."),
    C("due_date_known", "boolean", "False when the due date isn't known (export-file-only mode): the document date is used instead."),
    C("po_number", "text", "Purchase order number."),
    C("memo", "text", "Memo."),
    C("subtotal", "amount", "Total of the lines before tax."),
    C("tax_total", "amount", "Sales tax."),
    C("total", "amount", "Total, as in the ledger."),
    C("amount_paid", "amount", "Payments applied, to the end of the ledger."),
    C("amount_due", "amount", "Still owed at the end of the ledger."),
    C("status", "text", "paid, partial, unpaid or overpaid, worked out from the ledger."),
    C("wave_status", "text", "Wave's own status at the time Wave was read (blank without a connection)."),
    C("wave_total", "amount", "Wave's total (blank without a connection)."),
    C("wave_amount_paid", "amount", "Wave's amount paid (blank without a connection)."),
    C("wave_amount_due", "amount", "Wave's amount due (blank without a connection)."),
    C("lines_from", "text", "`wave` when the lines are Wave's line items; `ledger` when rebuilt from the ledger."),
    C("entry_ids", "list", "Ledger entries (journal.csv entry_id) that raised the document."),
    C("wave_id", "text", "Wave's ID for the document."),
  ];
};

const docRows = (docs: readonly OpenDocument[], h: Helpers) =>
  docs.map((d) => [
    d.id, d.number, d.contactId, h.contact(d.contactId)?.name ?? "", d.date, d.dueDate, h.bool(d.dueDateKnown), d.poNumber, d.memo,
    h.amt(d.subtotal), h.amt(d.taxTotal), h.amt(d.total), h.amt(d.amountPaid), h.amt(d.amountDue), d.status,
    d.wave?.status ?? "", h.opt(d.wave?.total), h.opt(d.wave?.amountPaid), h.opt(d.wave?.amountDue),
    d.linesFrom, h.list(d.entryIds), d.waveId,
  ]);

const lineColumns = (owner: string): ColumnSpec[] => [
  C(`${owner}_id`, "id", `The ${owner}.`),
  C("line_no", "integer", "Line number, from 1."),
  C("description", "text", "Line description."),
  C("quantity", "decimal", "Quantity."),
  C("unit_price", "decimal", "Unit price."),
  C("account_id", "id", "Account the line posts to (accounts.csv)."),
  C("account_code", "code", "That account's code."),
  C("item_id", "id", "Product or service (items.csv), if any."),
  C("amount", "amount", "Line amount before tax. Negative for discounts."),
  C("tax_amount", "amount", "Sales tax on the line."),
  C("tax_rate_ids", "list", "Sales taxes applied (tax_rates.csv)."),
];

const lineRows = (owners: readonly { id: string; lines: DocumentLine[] }[], h: Helpers) =>
  owners.flatMap((d) =>
    d.lines.map((l, i) => [
      d.id, String(i + 1), l.description, l.quantity, l.unitPrice, l.accountId, h.account(l.accountId)?.code ?? "",
      l.itemId, h.amt(l.amount), h.amt(l.taxAmount), h.list(l.taxRateIds),
    ]),
  );

const agingColumns: ColumnSpec[] = [
  C("as_of", "date", "The cutover date the aging is worked out at."),
  C("document_id", "id", "The invoice or bill."),
  C("number", "text", "Document number."),
  C("contact_id", "id", "Customer or vendor."),
  C("contact_name", "text", "Their name."),
  C("date", "date", "Document date."),
  C("due_date", "date", "Due date."),
  C("due_date_known", "boolean", "False when the due date isn't known; the document date is used."),
  C("days_past_due", "integer", "Days past due at as_of (0 if not yet due)."),
  C("bucket", "text", "current, 1-30, 31-60, 61-90 or 90+."),
  C("amount_due", "amount", "Owed at as_of: payments after as_of are not counted."),
];

export const TABLES: TableSpec[] = [
  {
    file: "accounts.csv", sheet: "Accounts",
    doc: "The chart of accounts: Wave's full chart when connected (including empty and archived accounts), otherwise every account that appears in the export. Identical Wave system accounts (Transfer Clearing, Accounts Receivable…) are merged into one row.",
    columns: [
      C("account_id", "id", "The account."),
      C("code", "code", "Chart code."),
      C("name", "text", "Account name."),
      C("type", "text", "ASSET, LIABILITY, EQUITY, INCOME or EXPENSE."),
      C("subtype", "text", "Wave's subtype, e.g. CASH_AND_BANK. Blank if unknown."),
      C("subtype_name", "text", "Wave's name for the subtype, as the export writes it."),
      C("normal_balance", "text", "DEBIT or CREDIT."),
      C("active", "boolean", "False for archived accounts. Archived accounts still carry their history."),
      C("is_system", "boolean", "True for accounts Wave creates itself."),
      C("wave_ids", "list", "Every Wave account folded into this row."),
      C("currency", "text", "Account currency, if Wave gives one."),
      C("description", "text", "Description."),
      C("wave_balance", "amount", "The balance Wave reported when it was read (blank without a connection). Normal-balance sign."),
      C("balance_at_cutover", "amount", "Balance at the cutover date, from the ledger. Normal-balance sign."),
      C("balance_at_end", "amount", "Balance at the last ledger date. Normal-balance sign."),
    ],
    rows(b) {
      const h = helpers(b);
      const cut = new Map(trialBalance(b.entries, b.accounts, b.period.cutoverDate).map((r) => [r.accountId, r.balance] as const));
      const end = new Map(trialBalance(b.entries, b.accounts).map((r) => [r.accountId, r.balance] as const));
      return b.accounts.map((a) => [
        a.id, a.code, a.name, a.type, a.subtype, a.subtypeName, a.normalBalance, h.bool(!a.isArchived), h.bool(a.isSystem),
        h.list(a.waveIds), a.currency, a.description, h.opt(a.waveBalance), h.amt(cut.get(a.id) ?? 0n), h.amt(end.get(a.id) ?? 0n),
      ]);
    },
  },
  {
    file: "contacts.csv", sheet: "Contacts",
    doc: "Customers and vendors. Names link the export to Wave; IDs are Wave's when connected.",
    columns: [
      C("contact_id", "id", "The contact."),
      C("role", "text", "customer or vendor."),
      C("name", "text", "Name."),
      C("email", "text", "Email."),
      C("phone", "text", "Phone."),
      C("currency", "text", "Currency."),
      C("active", "boolean", "False if archived in Wave."),
      C("address_line_1", "text", "Address."),
      C("address_line_2", "text", "Address."),
      C("city", "text", "City."),
      C("province", "text", "State or province."),
      C("postal_code", "text", "ZIP or postal code."),
      C("country", "text", "Country."),
      C("wave_id", "text", "Wave's ID."),
      C("other_details", "json", "Every other detail Wave or the export gave, by field name."),
    ],
    rows(b) {
      const h = helpers(b);
      return b.contacts.map((c) => [
        c.id, c.role, c.name, c.email, c.phone, c.currency, h.bool(!c.isArchived),
        c.address?.line1 ?? "", c.address?.line2 ?? "", c.address?.city ?? "", c.address?.province ?? "", c.address?.postalCode ?? "", c.address?.country ?? "",
        c.waveId, JSON.stringify(c.extra),
      ]);
    },
  },
  {
    file: "items.csv", sheet: "Items",
    doc: "Products and services (Wave connection only).",
    columns: [
      C("item_id", "id", "The item."), C("name", "text", "Name."), C("description", "text", "Description."),
      C("unit_price", "decimal", "Default price."), C("sold", "boolean", "Sold to customers."), C("bought", "boolean", "Bought from vendors."),
      C("income_account_id", "id", "Income account."), C("income_account_code", "code", "Its code."),
      C("expense_account_id", "id", "Expense account."), C("expense_account_code", "code", "Its code."),
      C("tax_rate_ids", "list", "Default sales taxes."), C("active", "boolean", "False if archived."),
    ],
    rows(b) {
      const h = helpers(b);
      return b.items.map((i) => [
        i.id, i.name, i.description, i.unitPrice, h.bool(i.isSold), h.bool(i.isBought),
        i.incomeAccountId, h.account(i.incomeAccountId)?.code ?? "", i.expenseAccountId, h.account(i.expenseAccountId)?.code ?? "",
        h.list(i.taxRateIds), h.bool(!i.isArchived),
      ]);
    },
  },
  {
    file: "tax_rates.csv", sheet: "Tax Rates",
    doc: "Sales taxes (Wave connection only).",
    columns: [
      C("tax_rate_id", "id", "The tax."), C("name", "text", "Name."), C("abbreviation", "text", "Abbreviation."), C("tax_number", "text", "Registration number."),
      C("rate", "decimal", "Rate in force at the end of the ledger, as a fraction (0.0825 = 8.25%)."),
      C("rate_history", "json", "Every rate by the date it took effect."),
      C("compound", "boolean", "Charged on top of other taxes."), C("recoverable", "boolean", "Tax paid on purchases can be recovered."), C("active", "boolean", "False if archived."),
    ],
    rows(b) {
      const h = helpers(b);
      return b.taxRates.map((t) => [
        t.id, t.name, t.abbreviation, t.taxNumber, t.rate, JSON.stringify(Object.fromEntries(t.rates.map((r) => [r.effective, r.rate]))),
        h.bool(t.isCompound), h.bool(t.isRecoverable), h.bool(!t.isArchived),
      ]);
    },
  },
  {
    file: "journal.csv", sheet: "Journal",
    doc: "The ledger: one row per line, every entry from Wave's export, in date order. Every entry balances. This is the full history whatever the scope setting.",
    columns: [
      C("entry_id", "id", "The entry: Wave's Transaction ID."),
      C("line_no", "integer", "Line number within the entry, from 1."),
      C("date", "date", "Entry date."),
      C("account_id", "id", "Account (accounts.csv)."),
      C("account_code", "code", "Account code."),
      C("account_name", "text", "Account name."),
      C("debit", "amount", "Debit, or 0.00."),
      C("credit", "amount", "Credit, or 0.00."),
      C("description", "text", "The entry's description."),
      C("line_description", "text", "The line's own description, if any."),
      C("customer_id", "id", "Customer on the line, if any."),
      C("vendor_id", "id", "Vendor on the line, if any."),
      C("contact", "text", "Customer or vendor name."),
      C("invoice_number", "text", "Invoice number on the line."),
      C("bill_number", "text", "Bill number on the line."),
      C("memo", "text", "Notes / memo."),
      C("sales_tax_name", "text", "Sales tax name, as the export gives it."),
      C("sales_tax_amount", "text", "Sales tax amount, as the export gives it (format not yet seen in a real export)."),
      C("entry_type", "text", "expense, refund, deposit, sales-receipt, transfer, credit-card-payment, invoice, invoice-payment, bill, bill-payment or journal."),
      C("entry_type_reason", "text", "Why the entry got that type."),
      C("rule_id", "text", "The classification rule that matched."),
      C("paired_entry_id", "id", "For a transfer recorded as two entries through Transfer Clearing: the other entry."),
      C("date_added", "date", "When the entry was added in Wave."),
      C("date_modified", "date", "When it was last changed in Wave."),
      C("source_ref", "text", "Where the line came from in Wave's export."),
    ],
    rows(b) {
      const h = helpers(b);
      return b.entries.flatMap((e) =>
        e.lines.map((l, i) => [
          e.id, String(i + 1), e.date, l.accountId, h.account(l.accountId)?.code ?? "", h.account(l.accountId)?.name ?? "",
          h.amt(l.debit), h.amt(l.credit), e.description, l.description, l.customerId, l.vendorId,
          h.contact(l.customerId)?.name ?? h.contact(l.vendorId)?.name ?? "", l.invoiceNumber, l.billNumber, l.memo,
          l.salesTaxName, l.salesTaxAmount, e.type, e.why, e.ruleId, e.pairedWith ?? "", e.dateAdded, e.dateModified,
          l.row ? `accounting.csv row ${l.row}` : "",
        ]),
      );
    },
  },
  { file: "invoices.csv", sheet: "Invoices", doc: "Invoices, with what was paid and is still owed. When connected, checked against Wave's invoices.", columns: docColumns("invoice"), rows: (b) => docRows(b.invoices, helpers(b)) },
  { file: "invoice_lines.csv", sheet: "Invoice Lines", doc: "Invoice line items: Wave's when connected, otherwise rebuilt from the ledger (one line per income line).", columns: lineColumns("invoice"), rows: (b) => lineRows(b.invoices, helpers(b)) },
  { file: "bills.csv", sheet: "Bills", doc: "Bills, rebuilt from the ledger (Wave's API has no bills). Not yet checked against a real export that uses bills.", columns: docColumns("bill"), rows: (b) => docRows(b.bills, helpers(b)) },
  { file: "bill_lines.csv", sheet: "Bill Lines", doc: "Bill lines, rebuilt from the ledger.", columns: lineColumns("bill"), rows: (b) => lineRows(b.bills, helpers(b)) },
  {
    file: "payments.csv", sheet: "Payments",
    doc: "Payments against invoices and bills: one row per application, so a deposit paying two invoices is two rows.",
    columns: [
      C("payment_id", "id", "The payment (its ledger entry)."),
      C("entry_id", "id", "Ledger entry (journal.csv)."),
      C("date", "date", "Payment date."),
      C("contact_id", "id", "Customer or vendor."),
      C("contact_name", "text", "Their name."),
      C("bank_account_id", "id", "Bank or card account the money moved through."),
      C("bank_account_code", "code", "Its code."),
      C("amount", "amount", "Total money moved by the payment (the same on every row of one payment)."),
      C("applied_to_type", "text", "invoice or bill."),
      C("applied_to_id", "id", "The invoice or bill (invoices.csv / bills.csv)."),
      C("applied_to_number", "text", "Its number."),
      C("applied_amount", "amount", "Amount applied to that document."),
      C("linked_by", "text", "wave-id (Wave's own link), invoice-date-amount (matched on number, date and amount) or ledger-number (invoice number on the ledger lines)."),
      C("wave_payment_id", "text", "Wave's payment ID, when connected."),
    ],
    rows(b) {
      const h = helpers(b);
      return [...b.invoices, ...b.bills].flatMap((d) => d.payments.map((p) => ({ p, d }))).sort((x, y) => x.p.date.localeCompare(y.p.date) || x.p.paymentId.localeCompare(y.p.paymentId) || x.p.appliedToNumber.localeCompare(y.p.appliedToNumber))
        .map(({ p, d }) => [
          p.paymentId, p.entryId, p.date, p.contactId, h.contact(p.contactId)?.name ?? "", p.bankAccountId, h.account(p.bankAccountId)?.code ?? "",
          h.amt(p.amount), p.appliedToType, d.id, p.appliedToNumber, h.amt(p.appliedAmount), p.linkedBy, p.wavePaymentId,
        ]);
    },
  },
  {
    file: "estimates.csv", sheet: "Estimates", doc: "Estimates (Wave connection only).",
    columns: [
      C("estimate_id", "id", "The estimate."), C("number", "text", "Number."), C("customer_id", "id", "Customer."), C("customer_name", "text", "Name."),
      C("date", "date", "Date."), C("expiry_date", "date", "Valid until."), C("status", "text", "Wave's status."), C("total", "amount", "Total."),
    ],
    rows(b) {
      const h = helpers(b);
      return b.estimates.map((e) => [e.id, e.number, e.contactId, h.contact(e.contactId)?.name ?? "", e.date, e.expiryDate, e.status, h.amt(e.total)]);
    },
  },
  { file: "estimate_lines.csv", sheet: "Estimate Lines", doc: "Estimate lines.", columns: lineColumns("estimate"), rows: (b) => lineRows(b.estimates, helpers(b)) },
  {
    file: "trial_balance.csv", sheet: "Trial Balance",
    doc: "Debits, credits and balance by account at the last ledger date, and again at the cutover date if that is earlier.",
    columns: [
      C("as_of", "date", "Date."), C("account_id", "id", "Account."), C("account_code", "code", "Code."), C("account_name", "text", "Name."),
      C("type", "text", "Account type."), C("debit", "amount", "Total debits to that date."), C("credit", "amount", "Total credits to that date."),
      C("balance", "amount", "Balance, normal-balance sign."),
    ],
    rows(b) {
      const h = helpers(b);
      const dates = [...new Set([b.period.cutoverDate, b.period.lastDate])].filter(Boolean).sort();
      return dates.flatMap((d) =>
        trialBalance(b.entries, b.accounts, d).map((r) => {
          const a = h.account(r.accountId)!;
          return [d, a.id, a.code, a.name, a.type, h.amt(r.debit), h.amt(r.credit), h.amt(r.balance)];
        }),
      );
    },
  },
  {
    file: "aging_ar.csv", sheet: "AR Aging", doc: "Open invoices at the cutover date, invoice by invoice.", columns: agingColumns,
    rows(b) {
      const h = helpers(b);
      return b.agingAr.map((r) => [b.period.cutoverDate, r.documentId, r.number, r.contactId, h.contact(r.contactId)?.name ?? "", r.date, r.dueDate, h.bool(r.dueDateKnown), String(r.daysPastDue), r.bucket, h.amt(r.amountDue)]);
    },
  },
  {
    file: "aging_ap.csv", sheet: "AP Aging", doc: "Open bills at the cutover date, bill by bill.", columns: agingColumns,
    rows(b) {
      const h = helpers(b);
      return b.agingAp.map((r) => [b.period.cutoverDate, r.documentId, r.number, r.contactId, h.contact(r.contactId)?.name ?? "", r.date, r.dueDate, h.bool(r.dueDateKnown), String(r.daysPastDue), r.bucket, h.amt(r.amountDue)]);
    },
  },
  {
    file: "attachments.csv", sheet: "Attachments", doc: "Receipt files in attachments/, and the entry each belongs to where it could be matched.",
    columns: [
      C("file", "text", "Path inside the package."), C("sha256", "text", "SHA-256 of the file."), C("bytes", "integer", "Size."),
      C("entry_id", "id", "Ledger entry it belongs to; blank if unlinked."),
      C("status", "text", "linked, ambiguous (several possible entries) or unmatched."),
      C("candidate_entry_ids", "list", "Entries it might belong to."),
    ],
    rows: (b) => b.receipts.map((r) => [`attachments/${r.fileName}`, r.sha256, String(r.bytes), r.entryId, r.status, JSON.stringify(r.candidates)]),
  },
  {
    file: "review_items.csv", sheet: "Review Items", doc: "Everything Wave Exit asked a person to look at, and the answer given.",
    columns: [
      C("item_id", "id", "The item."), C("kind", "text", "What sort of item."), C("severity", "text", "red (blocked outputs until answered) or amber."),
      C("title", "text", "Title."), C("explanation", "text", "Explanation."), C("answer", "text", "The answer given, if any."),
      C("options", "json", "The answers that were offered, value → label."), C("refs", "list", "Entries, accounts or documents it concerns."),
    ],
    rows: (b) => b.issues.map((i) => [i.id, i.kind, i.severity, i.title, i.explanation, i.resolution ?? "", JSON.stringify(Object.fromEntries(i.options.map((o) => [o.value, o.label]))), JSON.stringify(i.refs)]),
  },
];
