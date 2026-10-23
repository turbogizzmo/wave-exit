import { parse } from "csv-parse/sync";
import { unzipSync } from "fflate";
import { parseAmount, parseOptionalAmount, sum } from "../../money.ts";
import { agingAt } from "../../model/open-items.ts";
import { roleOf, type WaveAccountType } from "../../model/subtypes.ts";
import type { Account, Books, Contact, DocumentLine, Entry, Issue, Line, OpenDocument, PaymentApplication, ReceiptLink } from "../../model/types.ts";
import { InputProblem } from "../../problems.ts";
import { PACKAGE_FORMAT, PACKAGE_FORMAT_VERSION, type Manifest } from "./universal-package.ts";

/**
 * Read a universal package back into books. The package carries everything the
 * outputs need, so any output can be made again from the archive alone, and
 * writing what this returns gives the same package (tested).
 */
export function readUniversalPackage(zip: Uint8Array): { books: Books; attachments: Map<string, Uint8Array>; manifest: Manifest } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip);
  } catch (e) {
    throw new InputProblem("damaged-file", "This Wave Exit package is damaged or incomplete.", "Use another copy of the package.", String(e));
  }
  const text = (name: string) => {
    const f = files[name];
    if (!f) throw new InputProblem("missing-file", `This Wave Exit package is missing ${name}.`, "Use a complete copy of the package.");
    return new TextDecoder().decode(f);
  };
  const manifest = JSON.parse(text("manifest.json")) as Manifest;
  if (manifest.format !== PACKAGE_FORMAT || manifest.format_version > PACKAGE_FORMAT_VERSION) {
    throw new InputProblem("unsupported-format", "This package was made by a newer version of Wave Exit, or isn't a Wave Exit package.", "Update Wave Exit and try again.", `format ${manifest.format} v${manifest.format_version}`);
  }
  const exp = manifest.business.exponent;
  const amt = (s: string) => parseAmount(s, exp);
  const table = (name: string): Record<string, string>[] => parse(text(name), { bom: true, columns: true, skip_empty_lines: true, relax_column_count: false }) as Record<string, string>[];
  const bool = (s: string | undefined) => s === "true";
  const list = (s: string | undefined): string[] => (s ? (JSON.parse(s) as string[]) : []);

  const journal = table("journal.csv");
  const lineCounts = new Map<string, number>();
  for (const r of journal) lineCounts.set(r.account_id!, (lineCounts.get(r.account_id!) ?? 0) + 1);

  const accounts: Account[] = table("accounts.csv").map((r) => {
    const type = r.type as WaveAccountType;
    return {
      id: r.account_id!, code: r.code!, name: r.name!, group: ({ ASSET: "Asset", LIABILITY: "Liability", EQUITY: "Equity", INCOME: "Income", EXPENSE: "Expense" } as const)[type],
      type, subtype: r.subtype!, subtypeName: r.subtype_name!, normalBalance: r.normal_balance as "DEBIT" | "CREDIT",
      role: roleOf(type, r.subtype!), displayId: "", description: r.description!, currency: r.currency!,
      isArchived: !bool(r.active), isSystem: bool(r.is_system), waveIds: list(r.wave_ids),
      ...(r.wave_balance ? { waveBalance: amt(r.wave_balance) } : {}), lineCount: lineCounts.get(r.account_id!) ?? 0,
    };
  });

  const contacts: Contact[] = table("contacts.csv").map((r) => {
    const addr = [r.address_line_1, r.address_line_2, r.city, r.province, r.postal_code, r.country];
    return {
      id: r.contact_id!, role: r.role as "customer" | "vendor", name: r.name!, waveId: r.wave_id!, email: r.email!, phone: r.phone!, currency: r.currency!,
      isArchived: !bool(r.active),
      address: addr.some(Boolean) ? { line1: r.address_line_1!, line2: r.address_line_2!, city: r.city!, province: r.province!, postalCode: r.postal_code!, country: r.country! } : null,
      extra: JSON.parse(r.other_details || "{}") as Record<string, string>,
    };
  });

  const attachments = table("attachments.csv");
  const attachedTo = new Map<string, string[]>();
  for (const a of attachments) if (a.entry_id) attachedTo.set(a.entry_id, [...(attachedTo.get(a.entry_id) ?? []), a.file!.replace(/^attachments\//, "")]);

  const groups = new Map<string, Record<string, string>[]>();
  for (const r of journal) groups.set(r.entry_id!, [...(groups.get(r.entry_id!) ?? []), r]);
  const distinct = (xs: string[]) => [...new Set(xs.filter(Boolean))];
  const entries: Entry[] = [...groups].map(([id, rows]) => {
    const f = rows[0]!;
    const lines: Line[] = rows.map((r) => ({
      row: Number(/row (\d+)/.exec(r.source_ref ?? "")?.[1] ?? 0), accountId: r.account_id!, debit: amt(r.debit!), credit: amt(r.credit!),
      description: r.line_description!, customerId: r.customer_id!, vendorId: r.vendor_id!, invoiceNumber: r.invoice_number!, billNumber: r.bill_number!,
      memo: r.memo!, salesTaxName: r.sales_tax_name!, salesTaxAmount: r.sales_tax_amount!,
    }));
    return {
      id, date: f.date!, description: f.description!, memo: distinct(lines.map((l) => l.memo)).join("\n"), lines,
      customerId: distinct(lines.map((l) => l.customerId))[0] ?? "", vendorId: distinct(lines.map((l) => l.vendorId))[0] ?? "",
      invoiceNumbers: distinct(lines.map((l) => l.invoiceNumber)), billNumbers: distinct(lines.map((l) => l.billNumber)),
      dateAdded: f.date_added!, dateModified: f.date_modified!,
      debitTotal: sum(lines.map((l) => l.debit)), creditTotal: sum(lines.map((l) => l.credit)),
      type: f.entry_type as Entry["type"], why: f.entry_type_reason!, ruleId: f.rule_id!,
      ...(f.paired_entry_id ? { pairedWith: f.paired_entry_id } : {}),
      attachments: attachedTo.get(id) ?? [],
    };
  });

  const payRows = table("payments.csv");
  const lines = (name: string, owner: string): Map<string, DocumentLine[]> => {
    const m = new Map<string, DocumentLine[]>();
    for (const r of table(name)) {
      m.set(r[`${owner}_id`]!, [...(m.get(r[`${owner}_id`]!) ?? []), {
        description: r.description!, quantity: r.quantity!, unitPrice: r.unit_price!, accountId: r.account_id!, itemId: r.item_id!,
        amount: amt(r.amount!), taxAmount: amt(r.tax_amount!), taxRateIds: list(r.tax_rate_ids),
      }]);
    }
    return m;
  };
  const docs = (file: string, lineFile: string, kind: "invoice" | "bill"): OpenDocument[] => {
    const ls = lines(lineFile, kind);
    const who = kind === "invoice" ? "customer" : "vendor";
    return table(file).map((r) => {
      const id = r[`${kind}_id`]!;
      const payments: PaymentApplication[] = payRows.filter((p) => p.applied_to_id === id).map((p) => ({
        paymentId: p.payment_id!, entryId: p.entry_id!, date: p.date!, contactId: p.contact_id!, bankAccountId: p.bank_account_id!,
        amount: amt(p.amount!), appliedToType: p.applied_to_type as "invoice" | "bill", appliedToNumber: p.applied_to_number!,
        appliedAmount: amt(p.applied_amount!), linkedBy: p.linked_by as PaymentApplication["linkedBy"], wavePaymentId: p.wave_payment_id!,
      }));
      return {
        id, kind, number: r.number!, contactId: r[`${who}_id`]!, date: r.date!, dueDate: r.due_date!, dueDateKnown: bool(r.due_date_known),
        total: amt(r.total!), amountPaid: amt(r.amount_paid!), amountDue: amt(r.amount_due!),
        ...(r.wave_status ? { wave: { total: amt(r.wave_total!), amountPaid: amt(r.wave_amount_paid!), amountDue: amt(r.wave_amount_due!), status: r.wave_status } } : {}),
        status: r.status as OpenDocument["status"], entryIds: list(r.entry_ids), payments, waveId: r.wave_id!,
        poNumber: r.po_number!, memo: r.memo!, lines: ls.get(id) ?? [], linesFrom: r.lines_from as "wave" | "ledger",
        subtotal: amt(r.subtotal!), taxTotal: amt(r.tax_total!),
      };
    });
  };
  const invoices = docs("invoices.csv", "invoice_lines.csv", "invoice");
  const bills = docs("bills.csv", "bill_lines.csv", "bill");
  const estimateLines = lines("estimate_lines.csv", "estimate");

  const receipts: ReceiptLink[] = attachments.map((a) => ({
    fileName: a.file!.replace(/^attachments\//, ""), sha256: a.sha256!, bytes: Number(a.bytes), entryId: a.entry_id!,
    status: a.status as ReceiptLink["status"], candidates: list(a.candidate_entry_ids),
  }));
  const issues: Issue[] = table("review_items.csv").map((r) => ({
    id: r.item_id!, kind: r.kind as Issue["kind"], severity: r.severity as Issue["severity"], title: r.title!, explanation: r.explanation!,
    options: Object.entries(JSON.parse(r.options || "{}") as Record<string, string>).map(([value, label]) => ({ value, label })),
    ...(r.answer ? { resolution: r.answer } : {}), refs: list(r.refs),
  }));

  const attachmentBytes = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(files)) if (name.startsWith("attachments/") && !name.endsWith("/")) attachmentBytes.set(name.slice("attachments/".length), data);

  const books: Books = {
    mode: manifest.input_mode,
    business: manifest.business,
    period: manifest.period,
    ...(manifest.exported_at ? { exportedAt: manifest.exported_at } : {}),
    ...(manifest.wave_fetched_at ? { waveFetchedAt: manifest.wave_fetched_at } : {}),
    accounts, contacts, entries, invoices, bills,
    payments: [...invoices, ...bills].flatMap((d) => d.payments).sort((a, b) => a.date.localeCompare(b.date) || a.paymentId.localeCompare(b.paymentId) || a.appliedToNumber.localeCompare(b.appliedToNumber)),
    items: table("items.csv").map((r) => ({
      id: r.item_id!, name: r.name!, description: r.description!, unitPrice: r.unit_price!, isSold: bool(r.sold), isBought: bool(r.bought),
      incomeAccountId: r.income_account_id!, expenseAccountId: r.expense_account_id!, taxRateIds: list(r.tax_rate_ids), isArchived: !bool(r.active),
    })),
    taxRates: table("tax_rates.csv").map((r) => ({
      id: r.tax_rate_id!, name: r.name!, abbreviation: r.abbreviation!, taxNumber: r.tax_number!, rate: r.rate!,
      rates: Object.entries(JSON.parse(r.rate_history || "{}") as Record<string, string>).map(([effective, rate]) => ({ effective, rate })),
      isCompound: bool(r.compound), isRecoverable: bool(r.recoverable), isArchived: !bool(r.active),
    })),
    estimates: table("estimates.csv").map((r) => ({
      id: r.estimate_id!, number: r.number!, contactId: r.customer_id!, date: r.date!, expiryDate: r.expiry_date!, status: r.status!,
      total: parseOptionalAmount(r.total, exp), lines: estimateLines.get(r.estimate_id!) ?? [],
    })),
    agingAr: agingAt(invoices, manifest.period.cutoverDate),
    agingAp: agingAt(bills, manifest.period.cutoverDate),
    receipts, issues,
    checks: manifest.checks,
    notes: manifest.reader_notes,
    sources: manifest.source_files,
    settings: {
      scope: manifest.scope, cutoverDate: manifest.period.cutoverDate, resolutions: manifest.settings.resolutions,
      fiscalYearEndMonth: manifest.fiscal_year_end_month, ...(manifest.settings.rules_edited ? { rules: manifest.settings.rules } : {}),
    },
    rules: manifest.settings.rules,
  };
  return { books, attachments: attachmentBytes, manifest };
}
