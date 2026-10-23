import type { AccountGroup } from "../readers/transactions-export.ts";

/**
 * Wave's account subtype catalogue, as returned by the top-level `accountSubtypes`
 * query on 2026-10-23. Its `name` is exactly the export's `Account Type` text
 * (docs/wave-formats.md). Used when there is no Wave connection, and as a fallback
 * when the live catalogue lacks a name.
 */
export interface SubtypeInfo {
  value: string;
  name: string;
  type: WaveAccountType;
  systemCreated: boolean;
}

export type WaveAccountType = "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";

const C = (type: WaveAccountType, value: string, name: string, systemCreated = false): SubtypeInfo => ({ type, value, name, systemCreated });

export const BUILTIN_SUBTYPES: readonly SubtypeInfo[] = [
  C("ASSET", "CASH_AND_BANK", "Cash and Bank"),
  C("EXPENSE", "COST_OF_GOODS_SOLD", "Cost of Goods Sold"),
  C("LIABILITY", "CREDIT_CARD", "Credit Card"),
  C("LIABILITY", "CUSTOMER_PREPAYMENTS_AND_CREDITS", "Customer Prepayments and Customer Credits"),
  C("ASSET", "DEPRECIATION_AND_AMORTIZATION", "Depreciation and Amortization"),
  C("INCOME", "DISCOUNTS", "Discount"),
  C("LIABILITY", "DUE_FOR_PAYROLL", "Due For Payroll"),
  C("LIABILITY", "DUE_TO_YOU_AND_OTHER_OWNERS", "Due to You and Other Business Owners"),
  C("EXPENSE", "EXPENSE", "Operating Expense"),
  C("INCOME", "GAIN_ON_FOREIGN_EXCHANGE", "Gain On Foreign Exchange", true),
  C("INCOME", "INCOME", "Income"),
  C("ASSET", "INVENTORY", "Inventory"),
  C("LIABILITY", "LOANS", "Loan and Line of Credit"),
  C("EXPENSE", "LOSS_ON_FOREIGN_EXCHANGE", "Loss On Foreign Exchange", true),
  C("ASSET", "MONEY_IN_TRANSIT", "Money in Transit"),
  C("EQUITY", "NON_RETAINED_EARNINGS", "Business Owner Contribution and Drawing"),
  C("ASSET", "OTHER_CURRENT_ASSETS", "Other Short-Term Asset"),
  C("LIABILITY", "OTHER_CURRENT_LIABILITY", "Other Short-Term Liability"),
  C("INCOME", "OTHER_INCOME", "Other Income"),
  C("ASSET", "OTHER_LONG_TERM_ASSETS", "Other Long-Term Asset"),
  C("LIABILITY", "OTHER_LONG_TERM_LIABILITY", "Other Long-Term Liability"),
  C("LIABILITY", "PAYABLE", "Payable"),
  C("LIABILITY", "PAYABLE_BILLS", "System Payable Bill", true),
  C("LIABILITY", "PAYABLE_OTHER", "System Payable Non-Bill", true),
  C("EXPENSE", "PAYMENT_PROCESSING_FEES", "Payment Processing Fee"),
  C("EXPENSE", "PAYROLL_EXPENSES", "Payroll Expense"),
  C("ASSET", "PROPERTY_PLANT_EQUIPMENT", "Property, Plant, Equipment"),
  C("ASSET", "RECEIVABLE", "Receivable"),
  C("ASSET", "RECEIVABLE_INVOICES", "System Receivable Invoice", true),
  C("ASSET", "RECEIVABLE_OTHER", "System Receivable Non-Invoice", true),
  C("EQUITY", "RETAINED_EARNINGS", "Retained Earnings: Profit"),
  C("LIABILITY", "SALES_TAX", "Sales Tax on Sales and Purchases", true),
  C("LIABILITY", "SYSTEM_CUSTOMER_CREDITS", "System Customer Credits", true),
  C("ASSET", "TRANSFERS", "Transfers", true),
  C("EQUITY", "TRANSFERS", "Transfers", true),
  C("EXPENSE", "UNCATEGORIZED_EXPENSE", "Uncategorized Expense", true),
  C("INCOME", "UNCATEGORIZED_INCOME", "Uncategorized Income", true),
  C("ASSET", "UNKNOWN_ACCOUNT", "Unknown Account", true),
  C("ASSET", "VENDOR_PREPAYMENTS_AND_CREDITS", "Vendor Prepayments and Vendor Credits"),
];

export const GROUP_TO_TYPE: Record<AccountGroup, WaveAccountType> = {
  Asset: "ASSET",
  Liability: "LIABILITY",
  Equity: "EQUITY",
  Income: "INCOME",
  Expense: "EXPENSE",
};

export const TYPE_TO_GROUP: Record<WaveAccountType, AccountGroup> = {
  ASSET: "Asset",
  LIABILITY: "Liability",
  EQUITY: "Equity",
  INCOME: "Income",
  EXPENSE: "Expense",
};

export const normalBalanceOf = (t: WaveAccountType): "DEBIT" | "CREDIT" =>
  t === "ASSET" || t === "EXPENSE" ? "DEBIT" : "CREDIT";

/** Looks up subtypes by (group, export Account Type). Built from the live catalogue when connected. */
export class SubtypeCatalogue {
  private readonly byKey = new Map<string, SubtypeInfo>();
  private readonly byValue = new Map<string, SubtypeInfo>();

  constructor(live: readonly SubtypeInfo[] = []) {
    for (const s of [...BUILTIN_SUBTYPES, ...live]) {
      this.byKey.set(`${s.type}|${s.name.trim().toLowerCase()}`, s);
      this.byValue.set(`${s.type}|${s.value}`, s);
    }
  }

  forExport(group: AccountGroup, accountType: string): SubtypeInfo | undefined {
    return this.byKey.get(`${GROUP_TO_TYPE[group]}|${accountType.trim().toLowerCase()}`);
  }

  byTypeAndValue(type: string, value: string): SubtypeInfo | undefined {
    return this.byValue.get(`${type}|${value}`);
  }
}

/**
 * The part an account plays in a transaction, which drives classification. Derived
 * from the subtype, so every output sees the same thing.
 */
export type Role =
  | "bank"
  | "creditCard"
  | "receivable"
  | "payable"
  | "transferClearing"
  | "income"
  | "expense"
  | "salesTax"
  | "equity"
  | "customerCredit"
  | "otherAsset"
  | "otherLiability";

export function roleOf(type: WaveAccountType, subtype: string): Role {
  switch (subtype) {
    case "CASH_AND_BANK": return "bank";
    case "CREDIT_CARD": return "creditCard";
    case "RECEIVABLE_INVOICES": return "receivable";
    case "PAYABLE_BILLS": return "payable";
    case "TRANSFERS": return "transferClearing";
    case "SALES_TAX": return "salesTax";
    case "SYSTEM_CUSTOMER_CREDITS":
    case "CUSTOMER_PREPAYMENTS_AND_CREDITS": return "customerCredit";
  }
  switch (type) {
    case "ASSET": return "otherAsset";
    case "LIABILITY": return "otherLiability";
    case "EQUITY": return "equity";
    case "INCOME": return "income";
    case "EXPENSE": return "expense";
  }
}
