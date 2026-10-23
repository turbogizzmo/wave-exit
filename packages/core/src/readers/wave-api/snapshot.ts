import { formatPlain, parseAmount } from "../../money.ts";
import { InputProblem } from "../../problems.ts";
import { allPages, type WaveClient } from "./client.ts";
import * as Q from "./queries.ts";

/**
 * Everything Wave Exit reads from Wave's API for one business, normalised into
 * plain JSON (amounts as plain decimal strings). It is stored in the project, put
 * in the client collection file, and is the only thing the model sees from the API,
 * so a project never needs to talk to Wave again to add an output.
 */
export const SNAPSHOT_FORMAT = "wave-exit/wave-snapshot@1";

export interface SnapAddress {
  line1: string; line2: string; city: string; province: string; provinceCode: string;
  postalCode: string; country: string; countryCode: string;
}

export interface SnapAccount {
  id: string; name: string; description: string; displayId: string; currency: string;
  type: string; subtype: string; subtypeName: string; normalBalance: "DEBIT" | "CREDIT";
  isArchived: boolean;
  /** Current balance in the account's currency, normal-balance sign. */
  balance: string;
  balanceInBusinessCurrency: string;
}

export interface SnapContact {
  id: string; name: string; firstName: string; lastName: string; displayId: string;
  email: string; phone: string; mobile: string; fax: string; tollFree: string; website: string;
  currency: string; isArchived: boolean; address: SnapAddress | null;
  shipping?: { name: string; phone: string; instructions: string; address: SnapAddress | null } | null;
}

export interface SnapProduct {
  id: string; name: string; description: string; unitPrice: string; isSold: boolean; isBought: boolean;
  isArchived: boolean; incomeAccountId: string; expenseAccountId: string; salesTaxIds: string[];
}

export interface SnapSalesTax {
  id: string; name: string; abbreviation: string; description: string; taxNumber: string;
  isCompound: boolean; isRecoverable: boolean; isArchived: boolean;
  rates: { effective: string; rate: string }[];
}

export interface SnapInvoicePayment {
  id: string; date: string; amount: string; method: string; active: boolean; memo: string;
  accountId: string;
  /** The export's 19-digit Transaction ID, decoded from accountingTransactionId; "" if Wave gave none. */
  ledgerTransactionId: string;
}

export interface SnapLineItem {
  description: string; quantity: string; unitPrice: string; subtotal: string; total: string;
  accountId: string; productId: string; taxes: { salesTaxId: string; amount: string }[];
}

export interface SnapInvoice {
  id: string; number: string; date: string; dueDate: string; status: string; title: string;
  poNumber: string; memo: string; currency: string; exchangeRate: string;
  customerId: string; customerName: string;
  subtotal: string; taxTotal: string; discountTotal: string; total: string; amountPaid: string; amountDue: string;
  items: SnapLineItem[]; payments: SnapInvoicePayment[];
  attachments: { fileName: string; downloadUrl: string }[];
}

export interface SnapEstimate {
  id: string; number: string; date: string; dueDate: string; status: string; title: string;
  poNumber: string; memo: string; currency: string; customerId: string; customerName: string;
  subtotal: string; taxTotal: string; discountTotal: string; total: string;
  items: Omit<SnapLineItem, "taxes" | "subtotal">[];
}

export interface WaveSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  fetchedAt: string;
  connection: "full-access" | "oauth";
  user: { id: string; email: string; firstName: string; lastName: string };
  business: {
    id: string; name: string; isPersonal: boolean; isArchived: boolean; timezone: string; createdAt: string;
    currency: { code: string; symbol: string; exponent: number }; address: SnapAddress | null;
  };
  accountSubtypes: { value: string; name: string; type: string; systemCreated: boolean; archivable: boolean }[];
  accounts: SnapAccount[];
  customers: SnapContact[];
  vendors: SnapContact[];
  products: SnapProduct[];
  salesTaxes: SnapSalesTax[];
  invoices: SnapInvoice[];
  estimates: SnapEstimate[];
}

export interface WaveBusinessSummary { id: string; name: string; currency: string; isPersonal: boolean; isArchived: boolean }

export async function whoAmI(client: WaveClient): Promise<WaveSnapshot["user"]> {
  const d = await client.query<{ user: Raw }>(Q.Q_WHOAMI);
  return { id: s(d.user?.id), email: s(d.user?.defaultEmail), firstName: s(d.user?.firstName), lastName: s(d.user?.lastName) };
}

export async function listBusinesses(client: WaveClient): Promise<WaveBusinessSummary[]> {
  const nodes = await allPages<Raw>(async (page) => (await client.query<{ businesses: Conn }>(Q.Q_BUSINESSES, { page })).businesses);
  return nodes.map((b) => ({ id: s(b.id), name: s(b.name), currency: s(b.currency?.code), isPersonal: !!b.isPersonal, isArchived: !!b.isArchived }));
}

export type SnapshotProgress = (step: string, done: number) => void;

export async function fetchWaveSnapshot(
  client: WaveClient,
  businessId: string,
  opts: { onProgress?: SnapshotProgress; now?: () => Date } = {},
): Promise<WaveSnapshot> {
  const progress = opts.onProgress ?? (() => {});
  const conn = async (doc: string, key: string, extra: Record<string, unknown> = {}): Promise<Raw[]> => {
    const nodes = await allPages<Raw>(async (page) => {
      const d = await client.query<{ business: Raw | null }>(doc, { businessId, page, ...extra });
      if (!d.business) throw notFound(businessId);
      return d.business[key] as Conn;
    });
    progress(key, nodes.length);
    return dedupe(nodes);
  };

  const user = await whoAmI(client);
  const head = await client.query<{ business: Raw | null; accountSubtypes: Raw[] }>(Q.Q_BUSINESS, { businessId });
  if (!head.business) throw notFound(businessId);
  const b = head.business;
  const exponent = typeof b.currency?.exponent === "number" ? b.currency.exponent : 2;

  const accounts = [
    ...(await conn(Q.Q_ACCOUNTS, "accounts", { archived: false })),
    ...(await conn(Q.Q_ACCOUNTS, "accounts", { archived: true })),
  ];
  const customers = await conn(Q.Q_CUSTOMERS, "customers");
  const vendors = await conn(Q.Q_VENDORS, "vendors");
  const products = [
    ...(await conn(Q.Q_PRODUCTS, "products", { archived: false })),
    ...(await conn(Q.Q_PRODUCTS, "products", { archived: true })),
  ];
  const salesTaxes = [
    ...(await conn(Q.Q_SALES_TAXES, "salesTaxes", { archived: false })),
    ...(await conn(Q.Q_SALES_TAXES, "salesTaxes", { archived: true })),
  ];
  const invoices = await conn(Q.Q_INVOICES, "invoices");
  const estimates = await conn(Q.Q_ESTIMATES, "estimates");

  return {
    format: SNAPSHOT_FORMAT,
    fetchedAt: (opts.now?.() ?? new Date()).toISOString(),
    connection: client.credentialKind,
    user,
    business: {
      id: s(b.id), name: s(b.name), isPersonal: !!b.isPersonal, isArchived: !!b.isArchived,
      timezone: s(b.timezone), createdAt: s(b.createdAt),
      currency: { code: s(b.currency?.code), symbol: s(b.currency?.symbol), exponent },
      address: address(b.address),
    },
    accountSubtypes: (head.accountSubtypes ?? []).map((t) => ({
      value: s(t.value), name: s(t.name), type: s(t.type?.value), systemCreated: !!t.systemCreated, archivable: !!t.archivable,
    })),
    accounts: dedupe(accounts).map((a) => ({
      id: s(a.id), name: s(a.name), description: s(a.description), displayId: s(a.displayId),
      currency: s(a.currency?.code), type: s(a.type?.value), subtype: s(a.subtype?.value), subtypeName: s(a.subtype?.name),
      normalBalance: a.normalBalanceType === "CREDIT" ? "CREDIT" : "DEBIT",
      isArchived: !!a.isArchived,
      balance: decimal(a.balance, exponent), balanceInBusinessCurrency: decimal(a.balanceInBusinessCurrency, exponent),
    })),
    customers: customers.map((c) => ({
      ...contact(c),
      shipping: c.shippingDetails
        ? { name: s(c.shippingDetails.name), phone: s(c.shippingDetails.phone), instructions: s(c.shippingDetails.instructions), address: address(c.shippingDetails.address) }
        : null,
    })),
    vendors: vendors.map(contact),
    products: dedupe(products).map((p) => ({
      id: s(p.id), name: s(p.name), description: s(p.description), unitPrice: s(p.unitPrice),
      isSold: !!p.isSold, isBought: !!p.isBought, isArchived: !!p.isArchived,
      incomeAccountId: s(p.incomeAccount?.id), expenseAccountId: s(p.expenseAccount?.id),
      salesTaxIds: ((p.defaultSalesTaxes ?? []) as Raw[]).map((t) => s(t.id)),
    })),
    salesTaxes: dedupe(salesTaxes).map((t) => ({
      id: s(t.id), name: s(t.name), abbreviation: s(t.abbreviation), description: s(t.description), taxNumber: s(t.taxNumber),
      isCompound: !!t.isCompound, isRecoverable: !!t.isRecoverable, isArchived: !!t.isArchived,
      rates: ((t.rates ?? []) as Raw[]).map((r) => ({ effective: s(r.effective), rate: s(r.rate) })),
    })),
    invoices: invoices.map((i) => {
      const exp = typeof i.currency?.exponent === "number" ? i.currency.exponent : exponent;
      return {
        id: s(i.id), number: s(i.invoiceNumber), date: s(i.invoiceDate), dueDate: s(i.dueDate), status: s(i.status),
        title: s(i.title), poNumber: s(i.poNumber), memo: s(i.memo), currency: s(i.currency?.code), exchangeRate: s(i.exchangeRate),
        customerId: s(i.customer?.id), customerName: s(i.customer?.name),
        subtotal: money(i.subtotal, exp), taxTotal: money(i.taxTotal, exp), discountTotal: money(i.discountTotal, exp),
        total: money(i.total, exp), amountPaid: money(i.amountPaid, exp), amountDue: money(i.amountDue, exp),
        items: ((i.items ?? []) as Raw[]).map((it) => ({
          description: s(it.description), quantity: s(it.quantity), unitPrice: s(it.unitPrice),
          subtotal: money(it.subtotal, exp), total: money(it.total, exp),
          accountId: s(it.account?.id), productId: s(it.product?.id),
          taxes: ((it.taxes ?? []) as Raw[]).map((t) => ({ salesTaxId: s(t.salesTax?.id), amount: money(t.amount, exp) })),
        })),
        payments: ((i.payments ?? []) as Raw[]).map((p) => ({
          id: s(p.id), date: s(p.paymentDate), amount: decimal(p.amount, exp), method: s(p.paymentMethod),
          active: p.active !== false, memo: s(p.memo), accountId: s(p.account?.id),
          ledgerTransactionId: ledgerTransactionId(p.accountingTransactionId),
        })),
        attachments: ((i.attachments ?? []) as Raw[]).map((a) => ({ fileName: s(a.fileName), downloadUrl: s(a.downloadUrl) })),
      };
    }),
    estimates: estimates.map((e) => {
      const exp = typeof e.currency?.exponent === "number" ? e.currency.exponent : exponent;
      return {
        id: s(e.id), number: s(e.estimateNumber), date: s(e.estimateDate), dueDate: s(e.dueDate), status: s(e.status),
        title: s(e.title), poNumber: s(e.poNumber), memo: s(e.memo), currency: s(e.currency?.code),
        customerId: s(e.customer?.id), customerName: s(e.customer?.name),
        subtotal: money(e.subtotal, exp), taxTotal: money(e.taxTotal, exp), discountTotal: money(e.discountTotal, exp), total: money(e.total, exp),
        items: ((e.items ?? []) as Raw[]).map((it) => ({
          description: s(it.description), quantity: s(it.quantity), unitPrice: s(it.unitPrice), total: money(it.total, exp),
          accountId: s(it.account?.id), productId: s(it.product?.id),
        })),
      };
    }),
  };
}

/**
 * Wave's `accountingTransactionId` is a base64 global ID that decodes to
 * `Business:<uuid>;Transaction:<digits>`; the digits are the export's Transaction ID.
 */
export function ledgerTransactionId(globalId: unknown): string {
  if (typeof globalId !== "string" || !globalId) return "";
  try {
    const decoded = atob(globalId.replace(/-/g, "+").replace(/_/g, "/"));
    return /(?:^|;)Transaction:(\d+)$/.exec(decoded)?.[1] ?? "";
  } catch {
    return "";
  }
}

/** Check a stored snapshot (from a project or collection file) before trusting it. */
export function parseWaveSnapshot(json: unknown): WaveSnapshot {
  const o = json as Partial<WaveSnapshot> | null;
  if (!o || o.format !== SNAPSHOT_FORMAT || !o.business?.id || !Array.isArray(o.accounts) || !Array.isArray(o.invoices)) {
    throw new InputProblem(
      "unsupported-format",
      "This saved copy of the Wave connection data isn't in a format this version of Wave Exit understands.",
      "Reconnect to Wave to read the books again.",
      `format: ${String(o?.format)}`,
    );
  }
  return o as WaveSnapshot;
}

// ---- helpers -------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;
type Conn = { pageInfo: { totalPages: number | null }; edges: { node: Raw }[] };

const s = (v: unknown): string => (v == null ? "" : String(v));

function dedupe(nodes: Raw[]): Raw[] {
  const seen = new Set<string>();
  return nodes.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)));
}

function address(a: Raw | null | undefined): SnapAddress | null {
  if (!a) return null;
  return {
    line1: s(a.addressLine1), line2: s(a.addressLine2), city: s(a.city),
    province: s(a.province?.name), provinceCode: s(a.province?.code),
    postalCode: s(a.postalCode), country: s(a.country?.name), countryCode: s(a.country?.code),
  };
}

function contact(c: Raw): SnapContact {
  return {
    id: s(c.id), name: s(c.name), firstName: s(c.firstName), lastName: s(c.lastName), displayId: s(c.displayId),
    email: s(c.email), phone: s(c.phone), mobile: s(c.mobile), fax: s(c.fax), tollFree: s(c.tollFree), website: s(c.website),
    currency: s(c.currency?.code), isArchived: !!c.isArchived, address: address(c.address),
  };
}

/** A Wave `Money` object → plain decimal string, from `minorUnitValue` (exact). */
function money(m: Raw | null | undefined, exponent: number): string {
  if (!m) return formatPlain(0n, exponent);
  const minor = s(m.minorUnitValue).trim();
  if (/^-?\d+(\.0+)?$/.test(minor)) return formatPlain(BigInt(minor.replace(/\.0+$/, "")), exponent);
  // Fall back to `value`, which uses thousands separators.
  return formatPlain(parseAmount(s(m.value), exponent, { allowGrouping: true }), exponent);
}

/** A bare decimal (Account.balance, InvoicePayment.amount) → plain string with fixed places. */
function decimal(v: unknown, exponent: number): string {
  const t = s(v).trim();
  return formatPlain(t ? parseAmount(t, exponent, { allowGrouping: true }) : 0n, exponent);
}

function notFound(businessId: string): InputProblem {
  return new InputProblem(
    "wave-access-denied",
    "Wave says this business doesn't exist or this connection can't see it.",
    "Pick the business again from the list, or check that the person who connected can see it in Wave.",
    `businessId ${businessId}`,
  );
}
