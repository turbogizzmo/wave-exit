import type { Account } from "../../model/types.ts";

/**
 * Mapping Wave's chart onto a QuickBooks Online company. Each Wave account either
 * matches an account the company already has, or is created with the closest
 * QuickBooks type and detail type. The user can change any of it on the mapping
 * screen. Type names are the REST API's (developer.intuit.com Account entity; detail
 * types from Intuit's AccountSubTypeEnum).
 */

export interface QboAccountType {
  AccountType: string;
  AccountSubType: string;
}

export interface QboAccount {
  Id: string;
  Name: string;
  AccountType: string;
  AccountSubType?: string;
  AcctNum?: string;
  Active?: boolean;
  Classification?: string;
}

const T = (AccountType: string, AccountSubType: string): QboAccountType => ({ AccountType, AccountSubType });

/** Wave subtype → QuickBooks type/detail type. */
const BY_SUBTYPE: Record<string, QboAccountType> = {
  CASH_AND_BANK: T("Bank", "Checking"),
  MONEY_IN_TRANSIT: T("Other Current Asset", "UndepositedFunds"),
  RECEIVABLE_INVOICES: T("Accounts Receivable", "AccountsReceivable"),
  RECEIVABLE_OTHER: T("Other Current Asset", "OtherCurrentAssets"),
  RECEIVABLE: T("Other Current Asset", "OtherCurrentAssets"),
  OTHER_CURRENT_ASSETS: T("Other Current Asset", "OtherCurrentAssets"),
  INVENTORY: T("Other Current Asset", "Inventory"),
  VENDOR_PREPAYMENTS_AND_CREDITS: T("Other Current Asset", "PrepaidExpenses"),
  TRANSFERS: T("Other Current Asset", "OtherCurrentAssets"),
  UNKNOWN_ACCOUNT: T("Other Current Asset", "OtherCurrentAssets"),
  PROPERTY_PLANT_EQUIPMENT: T("Fixed Asset", "MachineryAndEquipment"),
  DEPRECIATION_AND_AMORTIZATION: T("Fixed Asset", "AccumulatedDepreciation"),
  OTHER_LONG_TERM_ASSETS: T("Other Asset", "OtherLongTermAssets"),
  CREDIT_CARD: T("Credit Card", "CreditCard"),
  PAYABLE_BILLS: T("Accounts Payable", "AccountsPayable"),
  PAYABLE: T("Other Current Liability", "OtherCurrentLiabilities"),
  PAYABLE_OTHER: T("Other Current Liability", "OtherCurrentLiabilities"),
  SALES_TAX: T("Other Current Liability", "SalesTaxPayable"),
  DUE_FOR_PAYROLL: T("Other Current Liability", "PayrollClearing"),
  DUE_TO_YOU_AND_OTHER_OWNERS: T("Other Current Liability", "OtherCurrentLiabilities"),
  CUSTOMER_PREPAYMENTS_AND_CREDITS: T("Other Current Liability", "OtherCurrentLiabilities"),
  SYSTEM_CUSTOMER_CREDITS: T("Other Current Liability", "OtherCurrentLiabilities"),
  OTHER_CURRENT_LIABILITY: T("Other Current Liability", "OtherCurrentLiabilities"),
  LOANS: T("Long Term Liability", "NotesPayable"),
  OTHER_LONG_TERM_LIABILITY: T("Long Term Liability", "OtherLongTermLiabilities"),
  NON_RETAINED_EARNINGS: T("Equity", "OwnersEquity"),
  RETAINED_EARNINGS: T("Equity", "RetainedEarnings"),
  INCOME: T("Income", "ServiceFeeIncome"),
  DISCOUNTS: T("Income", "DiscountsRefundsGiven"),
  OTHER_INCOME: T("Other Income", "OtherMiscellaneousIncome"),
  UNCATEGORIZED_INCOME: T("Income", "OtherPrimaryIncome"),
  GAIN_ON_FOREIGN_EXCHANGE: T("Other Income", "OtherMiscellaneousIncome"),
  COST_OF_GOODS_SOLD: T("Cost of Goods Sold", "SuppliesMaterialsCogs"),
  EXPENSE: T("Expense", "OfficeGeneralAdministrativeExpenses"),
  PAYMENT_PROCESSING_FEES: T("Expense", "BankCharges"),
  PAYROLL_EXPENSES: T("Expense", "PayrollExpenses"),
  UNCATEGORIZED_EXPENSE: T("Expense", "OtherMiscellaneousServiceCost"),
  LOSS_ON_FOREIGN_EXCHANGE: T("Other Expense", "ExchangeGainOrLoss"),
};

const BY_TYPE: Record<Account["type"], QboAccountType> = {
  ASSET: T("Other Current Asset", "OtherCurrentAssets"),
  LIABILITY: T("Other Current Liability", "OtherCurrentLiabilities"),
  EQUITY: T("Equity", "OwnersEquity"),
  INCOME: T("Income", "OtherPrimaryIncome"),
  EXPENSE: T("Expense", "OtherMiscellaneousServiceCost"),
};

export function qboTypeFor(a: Account): QboAccountType {
  if (a.subtype === "CASH_AND_BANK" && /saving/i.test(a.name)) return T("Bank", "Savings");
  if (a.id === "wave-exit:opening-balance-equity") return T("Equity", "OpeningBalanceEquity");
  return BY_SUBTYPE[a.subtype] ?? BY_TYPE[a.type];
}

/** QuickBooks's broad class for each type, to stop an asset mapping to an expense. */
export const CLASSIFICATION: Record<string, "Asset" | "Liability" | "Equity" | "Revenue" | "Expense"> = {
  Bank: "Asset", "Accounts Receivable": "Asset", "Other Current Asset": "Asset", "Fixed Asset": "Asset", "Other Asset": "Asset",
  "Accounts Payable": "Liability", "Credit Card": "Liability", "Other Current Liability": "Liability", "Long Term Liability": "Liability",
  Equity: "Equity", Income: "Revenue", "Other Income": "Revenue", "Cost of Goods Sold": "Expense", Expense: "Expense", "Other Expense": "Expense",
};

/** Names QuickBooks accepts: at most 100 characters, no `"` or `:`. */
export function qboName(name: string, max = 100): string {
  return name.replace(/"/g, "'").replace(/:/g, " -").replace(/\s+/g, " ").trim().slice(0, max) || "Unnamed";
}

export type AccountChoice = { kind: "existing"; qboId: string } | { kind: "create"; name: string; type: QboAccountType };

export interface AccountMapping {
  /** Wave Exit account ID → what to do with it. */
  choices: Map<string, AccountChoice>;
  /** Why each default was chosen, for the mapping screen. */
  reasons: Map<string, string>;
}

/**
 * Default mapping. Accounts receivable and payable, retained earnings and opening
 * balance equity use the company's own (QuickBooks keeps one of each); other
 * accounts match an active account of the same name and broad class, or are
 * created. `overrides` (from the mapping screen) win.
 */
export function defaultMapping(accounts: readonly Account[], existing: readonly QboAccount[], overrides: Record<string, string> = {}): AccountMapping {
  const choices = new Map<string, AccountChoice>();
  const reasons = new Map<string, string>();
  const active = existing.filter((x) => x.Active !== false);
  const takenNames = new Set(existing.map((x) => x.Name.toLowerCase()));
  const byName = new Map(active.map((x) => [x.Name.toLowerCase(), x] as const));
  const firstOf = (pred: (x: QboAccount) => boolean) => active.find(pred);

  for (const a of accounts) {
    const want = qboTypeFor(a);
    const o = overrides[a.id];
    if (o && o !== "create" && existing.some((x) => x.Id === o)) {
      choices.set(a.id, { kind: "existing", qboId: o });
      reasons.set(a.id, "Chosen on the mapping screen.");
      continue;
    }
    let match: QboAccount | undefined;
    if (o !== "create") {
      if (want.AccountType === "Accounts Receivable") match = firstOf((x) => x.AccountType === "Accounts Receivable");
      else if (want.AccountType === "Accounts Payable") match = firstOf((x) => x.AccountType === "Accounts Payable");
      else if (want.AccountSubType === "RetainedEarnings") match = firstOf((x) => x.AccountSubType === "RetainedEarnings");
      else if (want.AccountSubType === "OpeningBalanceEquity") match = firstOf((x) => x.AccountSubType === "OpeningBalanceEquity");
      if (!match) {
        const same = byName.get(qboName(a.name).toLowerCase());
        if (same && CLASSIFICATION[same.AccountType] === CLASSIFICATION[want.AccountType]) match = same;
      }
    }
    if (match) {
      choices.set(a.id, { kind: "existing", qboId: match.Id });
      reasons.set(a.id, match.Name.toLowerCase() === qboName(a.name).toLowerCase() ? "Same name and kind in QuickBooks." : `QuickBooks keeps one ${match.AccountType === "Equity" ? match.AccountSubType : match.AccountType} account.`);
      continue;
    }
    // Create, with a name QuickBooks will accept and that doesn't clash.
    let name = qboName(a.name);
    for (let n = 2; takenNames.has(name.toLowerCase()); n++) name = qboName(`${a.name} (${n})`);
    takenNames.add(name.toLowerCase());
    choices.set(a.id, { kind: "create", name, type: want });
    reasons.set(a.id, `New ${want.AccountType} account.`);
  }
  return { choices, reasons };
}
