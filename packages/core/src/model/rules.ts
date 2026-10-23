import type { Minor } from "../money.ts";
import type { Role } from "./subtypes.ts";

/**
 * The classification table. Every entry is classified once, here, by the roles of
 * the accounts on its lines, and every output uses the result. The table is plain
 * data so Review can show it (advanced, collapsed) and the user can edit it; the
 * first enabled rule that matches wins, and anything unmatched is a journal entry.
 */

export type EntryType =
  | "expense"
  | "refund"
  | "deposit"
  | "sales-receipt"
  | "transfer"
  | "transfer-leg"
  | "credit-card-payment"
  | "invoice"
  | "invoice-payment"
  | "bill"
  | "bill-payment"
  | "journal";

/** `money` matches bank or credit card lines. */
export type RoleOrMoney = Role | "money";

export interface RuleCondition {
  /** Each of these roles must appear on at least one line. */
  has?: RoleOrMoney[];
  /** No line may have a role outside this list. */
  only?: RoleOrMoney[];
  /** The net of these roles' lines must be on this side (debit = net debit > 0). */
  net?: { role: RoleOrMoney; side: "debit" | "credit" }[];
  invoiceNumber?: boolean;
  billNumber?: boolean;
  /** Exactly this many lines with the given role. */
  count?: { role: RoleOrMoney; n: number }[];
}

export interface ClassificationRule {
  id: string;
  enabled: boolean;
  /** Plain-English name shown in the rules table. */
  label: string;
  type: EntryType;
  /** If set and the entry has a customer, use this type instead (deposit → sales receipt). */
  typeIfCustomer?: EntryType;
  when: RuleCondition;
  /** Sentence shown as the entry's "why". */
  why: string;
}

const MONEY_ROLES: readonly Role[] = ["bank", "creditCard"];

export const DEFAULT_RULES: readonly ClassificationRule[] = [
  {
    id: "invoice", enabled: true, label: "Invoice", type: "invoice",
    when: { has: ["receivable"], only: ["receivable", "income", "salesTax", "expense"], net: [{ role: "receivable", side: "debit" }], invoiceNumber: true },
    why: "Charges a customer: it increases accounts receivable against income and carries an invoice number.",
  },
  {
    id: "invoice-payment", enabled: true, label: "Invoice payment", type: "invoice-payment",
    when: { has: ["receivable", "money"], only: ["receivable", "money", "expense"], net: [{ role: "receivable", side: "credit" }], invoiceNumber: true },
    why: "Money received against an invoice: it reduces accounts receivable and carries the invoice number.",
  },
  {
    id: "bill", enabled: true, label: "Bill", type: "bill",
    when: { has: ["payable"], only: ["payable", "expense", "salesTax", "otherAsset"], net: [{ role: "payable", side: "credit" }], billNumber: true },
    why: "A vendor's bill: it increases accounts payable against expenses and carries a bill number.",
  },
  {
    id: "bill-payment", enabled: true, label: "Bill payment", type: "bill-payment",
    when: { has: ["payable", "money"], only: ["payable", "money"], net: [{ role: "payable", side: "debit" }], billNumber: true },
    why: "Money paid against a bill: it reduces accounts payable and carries the bill number.",
  },
  {
    id: "transfer-direct", enabled: true, label: "Transfer between bank accounts", type: "transfer",
    when: { only: ["bank"], count: [{ role: "bank", n: 2 }] },
    why: "Money moved directly between two bank accounts.",
  },
  {
    id: "credit-card-payment-direct", enabled: true, label: "Credit card payment", type: "credit-card-payment",
    when: { only: ["bank", "creditCard"], count: [{ role: "bank", n: 1 }, { role: "creditCard", n: 1 }], net: [{ role: "bank", side: "credit" }] },
    why: "A bank account paid down a credit card.",
  },
  {
    id: "transfer-leg", enabled: true, label: "One side of a transfer (through Transfer Clearing)", type: "transfer-leg",
    when: { has: ["transferClearing", "money"], only: ["transferClearing", "money"], count: [{ role: "money", n: 1 }] },
    why: "One side of a transfer: Wave records transfers as two entries that meet in a Transfer Clearing account.",
  },
  {
    id: "expense", enabled: true, label: "Expense", type: "expense",
    when: { has: ["money", "expense"], only: ["money", "expense"], count: [{ role: "money", n: 1 }], net: [{ role: "money", side: "credit" }] },
    why: "Paid from a bank or credit card account to expense accounts.",
  },
  {
    id: "refund", enabled: true, label: "Expense refund", type: "refund",
    when: { has: ["money", "expense"], only: ["money", "expense"], count: [{ role: "money", n: 1 }], net: [{ role: "money", side: "debit" }] },
    why: "Money came back into a bank or credit card account from expense accounts, such as a vendor refund.",
  },
  {
    id: "deposit", enabled: true, label: "Deposit", type: "deposit", typeIfCustomer: "sales-receipt",
    when: { has: ["money", "income"], only: ["money", "income", "otherAsset", "otherLiability", "salesTax", "expense"], count: [{ role: "money", n: 1 }], net: [{ role: "money", side: "debit" }, { role: "income", side: "credit" }], invoiceNumber: false },
    why: "Money received into a bank account as income, without an invoice (a sales receipt when a customer is named).",
  },
];

/** What the rules look at, computed once per entry. */
export interface EntryShape {
  roleCounts: Map<Role, number>;
  /** Net debit (positive) or credit (negative) per role. */
  roleNet: Map<Role, Minor>;
  hasInvoiceNumber: boolean;
  hasBillNumber: boolean;
  hasCustomer: boolean;
}

const rolesOf = (r: RoleOrMoney): readonly Role[] => (r === "money" ? MONEY_ROLES : [r]);

function count(shape: EntryShape, r: RoleOrMoney): number {
  return rolesOf(r).reduce((n, x) => n + (shape.roleCounts.get(x) ?? 0), 0);
}

function net(shape: EntryShape, r: RoleOrMoney): Minor {
  return rolesOf(r).reduce((n, x) => n + (shape.roleNet.get(x) ?? 0n), 0n);
}

export function ruleMatches(rule: ClassificationRule, shape: EntryShape): boolean {
  const w = rule.when;
  if (w.has && !w.has.every((r) => count(shape, r) > 0)) return false;
  if (w.only) {
    const allowed = new Set(w.only.flatMap(rolesOf));
    for (const role of shape.roleCounts.keys()) if (!allowed.has(role)) return false;
  }
  if (w.count && !w.count.every((c) => count(shape, c.role) === c.n)) return false;
  if (w.net && !w.net.every((n) => (n.side === "debit" ? net(shape, n.role) > 0n : net(shape, n.role) < 0n))) return false;
  if (w.invoiceNumber !== undefined && w.invoiceNumber !== shape.hasInvoiceNumber) return false;
  if (w.billNumber !== undefined && w.billNumber !== shape.hasBillNumber) return false;
  return true;
}

export const JOURNAL_WHY = "Doesn't fit a simpler transaction type (for example several accounts, equity, or an adjustment), so it is kept as a journal entry.";

export function classify(rules: readonly ClassificationRule[], shape: EntryShape): { type: EntryType; ruleId: string; why: string } {
  for (const rule of rules) {
    if (!rule.enabled || !ruleMatches(rule, shape)) continue;
    const type = rule.typeIfCustomer && shape.hasCustomer ? rule.typeIfCustomer : rule.type;
    return { type, ruleId: rule.id, why: rule.why };
  }
  return { type: "journal", ruleId: "journal", why: JOURNAL_WHY };
}
