import type { Minor } from "../money.ts";
import type { ReaderNote, SourceFileInfo } from "../readers/common.ts";
import type { AccountGroup } from "../readers/transactions-export.ts";
import type { ClassificationRule, EntryType } from "./rules.ts";
import type { Role, WaveAccountType } from "./subtypes.ts";

export type InputMode = "connected" | "export-file-only";

export interface Account {
  /** Stable across re-runs: `wave:<id>` when matched to Wave, else `export:<group>:<type>:<name>`. */
  id: string;
  /** Chart code: Wave's account number when it has a unique one, else assigned by type (1000s assets …). May change if the chart changes; `id` doesn't. */
  code: string;
  name: string;
  group: AccountGroup;
  type: WaveAccountType;
  /** Wave subtype value (e.g. CASH_AND_BANK); "" when unknown. */
  subtype: string;
  /** Wave's display name for the subtype, as the export writes it. */
  subtypeName: string;
  normalBalance: "DEBIT" | "CREDIT";
  role: Role;
  displayId: string;
  description: string;
  currency: string;
  isArchived: boolean;
  isSystem: boolean;
  /** Every Wave account folded into this one (identical system accounts are merged). */
  waveIds: string[];
  /** Wave's current balance (sum over waveIds), normal-balance sign. Undefined without a connection. */
  waveBalance?: Minor;
  /** Lines in the ledger. */
  lineCount: number;
}

export interface Contact {
  /** `wave:<id>` or `export-customer:<name>` / `export-vendor:<name>`. */
  id: string;
  role: "customer" | "vendor";
  name: string;
  waveId: string;
  email: string;
  phone: string;
  currency: string;
  isArchived: boolean;
  address: { line1: string; line2: string; city: string; province: string; postalCode: string; country: string } | null;
  /** Remaining fields from the export or Wave, for outputs that want them. */
  extra: Record<string, string>;
}

export interface Line {
  /** Row in accounting.csv. */
  row: number;
  accountId: string;
  debit: Minor;
  credit: Minor;
  description: string;
  customerId: string;
  vendorId: string;
  invoiceNumber: string;
  billNumber: string;
  memo: string;
  salesTaxName: string;
  salesTaxAmount: string;
}

export interface Entry {
  /** Wave's Transaction ID (19 digits). */
  id: string;
  date: string;
  description: string;
  memo: string;
  lines: Line[];
  customerId: string;
  vendorId: string;
  invoiceNumbers: string[];
  billNumbers: string[];
  dateAdded: string;
  dateModified: string;
  debitTotal: Minor;
  creditTotal: Minor;
  type: EntryType;
  /** Plain-English reason for `type`. */
  why: string;
  ruleId: string;
  /** For transfers through Transfer Clearing: the other leg's entry ID. */
  pairedWith?: string;
  /** Receipt files linked to this entry. */
  attachments: string[];
}

export interface PaymentApplication {
  /** Entry (Transaction ID) of the payment, or the Wave payment ID when the ledger has none. */
  paymentId: string;
  entryId: string;
  date: string;
  contactId: string;
  /** Account the money moved through. */
  bankAccountId: string;
  /** Total money moved by the payment entry. */
  amount: Minor;
  appliedToType: "invoice" | "bill";
  appliedToNumber: string;
  appliedAmount: Minor;
  /** How the link was made. */
  linkedBy: "wave-id" | "invoice-date-amount" | "ledger-number";
  wavePaymentId: string;
}

export interface OpenDocument {
  /** `wave:<id>` or `export-invoice:<number>` / `export-bill:<vendor>:<number>`. */
  id: string;
  kind: "invoice" | "bill";
  number: string;
  contactId: string;
  date: string;
  dueDate: string;
  /** False in export-file-only mode: the due date is not in the export, the document date is used. */
  dueDateKnown: boolean;
  total: Minor;
  /** Payments up to the end of the ledger. */
  amountPaid: Minor;
  amountDue: Minor;
  /** Wave's own figures when connected (for check 4). */
  wave?: { total: Minor; amountPaid: Minor; amountDue: Minor; status: string };
  status: "paid" | "partial" | "unpaid" | "overpaid";
  /** Ledger entries that created the document. */
  entryIds: string[];
  payments: PaymentApplication[];
  waveId: string;
  poNumber: string;
  memo: string;
  /** Line items: from Wave when connected, else rebuilt from the ledger lines. */
  lines: DocumentLine[];
  /** Where the lines came from. */
  linesFrom: "wave" | "ledger";
  subtotal: Minor;
  taxTotal: Minor;
}

export interface DocumentLine {
  description: string;
  /** Decimal text as Wave gives it ("12", "1.5"); "1" for rebuilt lines. */
  quantity: string;
  unitPrice: string;
  accountId: string;
  itemId: string;
  /** Before tax. Negative for discount lines. */
  amount: Minor;
  taxAmount: Minor;
  taxRateIds: string[];
}

export interface Item {
  id: string;
  name: string;
  description: string;
  unitPrice: string;
  isSold: boolean;
  isBought: boolean;
  incomeAccountId: string;
  expenseAccountId: string;
  taxRateIds: string[];
  isArchived: boolean;
}

export interface TaxRate {
  id: string;
  name: string;
  abbreviation: string;
  taxNumber: string;
  /** Rate in force on the last ledger date, as a decimal fraction ("0.0825"). */
  rate: string;
  rates: { effective: string; rate: string }[];
  isCompound: boolean;
  isRecoverable: boolean;
  isArchived: boolean;
}

export interface Estimate {
  id: string;
  number: string;
  contactId: string;
  date: string;
  expiryDate: string;
  status: string;
  total: Minor;
  lines: DocumentLine[];
}

export interface AgingRow {
  documentId: string;
  kind: "invoice" | "bill";
  number: string;
  contactId: string;
  date: string;
  dueDate: string;
  dueDateKnown: boolean;
  amountDue: Minor;
  daysPastDue: number;
  bucket: AgingBucket;
}

export type AgingBucket = "current" | "1-30" | "31-60" | "61-90" | "90+";

export interface ReceiptLink {
  fileName: string;
  sha256: string;
  bytes: number;
  entryId: string;
  status: "linked" | "ambiguous" | "unmatched";
  candidates: string[];
}

export type Severity = "red" | "amber" | "green";

export interface IssueOption {
  value: string;
  label: string;
}

/** Something that needs a human, with a one-click answer. */
export interface Issue {
  /** Stable across re-runs, so a stored answer applies again. */
  id: string;
  kind:
    | "ambiguous-account"
    | "account-not-in-wave"
    | "unknown-account-type"
    | "unbalanced-entry"
    | "unpaired-transfer"
    | "receipt-unmatched"
    | "receipt-ambiguous"
    | "invoice-mismatch"
    | "payment-unlinked"
    | "unlinked-receivable"
    | "unlinked-payable"
    | "balance-difference"
    | "wrong-business"
    | "reader-note"
    | "output-limit";
  severity: Severity;
  title: string;
  explanation: string;
  options: IssueOption[];
  /** The stored answer, if any. An answered red issue no longer blocks outputs. */
  resolution?: string;
  /** Entry IDs, account IDs, rows… for the UI to show. */
  refs: string[];
}

export interface CheckResult {
  id: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  title: string;
  status: Severity | "skipped";
  summary: string;
  details: string[];
}

export interface Settings {
  /** ISO date. Defaults to the last ledger date. */
  cutoverDate?: string;
  scope: "full-history" | "opening-balances";
  /** Answers to issue cards, by issue ID. */
  resolutions: Record<string, string>;
  /** Replaces the default classification table when set. */
  rules?: ClassificationRule[];
  /** Month (1–12) the fiscal year ends in, for the yearly reports. Wave's API doesn't expose it; default 12. */
  fiscalYearEndMonth?: number;
}

export interface Books {
  mode: InputMode;
  business: { name: string; waveId: string; currency: string; exponent: number };
  period: { firstDate: string; lastDate: string; cutoverDate: string };
  exportedAt?: string;
  waveFetchedAt?: string;
  accounts: Account[];
  contacts: Contact[];
  entries: Entry[];
  invoices: OpenDocument[];
  bills: OpenDocument[];
  payments: PaymentApplication[];
  items: Item[];
  taxRates: TaxRate[];
  estimates: Estimate[];
  agingAr: AgingRow[];
  agingAp: AgingRow[];
  receipts: ReceiptLink[];
  issues: Issue[];
  checks: CheckResult[];
  notes: ReaderNote[];
  sources: SourceFileInfo[];
  settings: Settings;
  rules: ClassificationRule[];
}
