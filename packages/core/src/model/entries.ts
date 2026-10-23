import { formatPlain, sum, type Minor } from "../money.ts";
import type { LedgerRow } from "../readers/transactions-export.ts";
import { exportKey } from "./accounts.ts";
import { classify, type ClassificationRule, type EntryShape } from "./rules.ts";
import type { Role } from "./subtypes.ts";
import type { Account, Entry, Issue, Line } from "./types.ts";

/** Group ledger rows into entries by Transaction ID, keeping the export's row order. */
export function buildEntries(
  ledger: readonly LedgerRow[],
  accountIdByExportKey: Map<string, string>,
  contactIdByName: Map<string, string>,
): Entry[] {
  const groups = new Map<string, LedgerRow[]>();
  for (const r of ledger) {
    const g = groups.get(r.transactionId);
    if (g) g.push(r);
    else groups.set(r.transactionId, [r]);
  }
  const entries: Entry[] = [];
  for (const [id, rows] of groups) {
    const first = rows[0]!;
    const lines: Line[] = rows.map((r) => ({
      row: r.row,
      accountId: accountIdByExportKey.get(exportKey(r))!,
      debit: r.debit,
      credit: r.credit,
      description: r.lineDescription,
      customerId: r.customer ? (contactIdByName.get(`customer|${r.customer}`) ?? "") : "",
      vendorId: r.vendor ? (contactIdByName.get(`vendor|${r.vendor}`) ?? "") : "",
      invoiceNumber: r.invoiceNumber,
      billNumber: r.billNumber,
      memo: r.memo,
      salesTaxName: r.salesTaxName,
      salesTaxAmount: r.salesTaxAmount,
    }));
    const distinct = (xs: string[]) => [...new Set(xs.filter(Boolean))];
    entries.push({
      id,
      date: first.date,
      description: first.description,
      memo: distinct(rows.map((r) => r.memo)).join("\n"),
      lines,
      customerId: distinct(lines.map((l) => l.customerId))[0] ?? "",
      vendorId: distinct(lines.map((l) => l.vendorId))[0] ?? "",
      invoiceNumbers: distinct(rows.map((r) => r.invoiceNumber)),
      billNumbers: distinct(rows.map((r) => r.billNumber)),
      dateAdded: first.dateAdded,
      dateModified: rows.map((r) => r.dateModified).sort().at(-1) ?? "",
      debitTotal: sum(lines.map((l) => l.debit)),
      creditTotal: sum(lines.map((l) => l.credit)),
      type: "journal",
      why: "",
      ruleId: "",
      attachments: [],
    });
  }
  entries.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return entries;
}

export function shapeOf(entry: Entry, accounts: Map<string, Account>): EntryShape {
  const roleCounts = new Map<Role, number>();
  const roleNet = new Map<Role, Minor>();
  for (const l of entry.lines) {
    const role = accounts.get(l.accountId)!.role;
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    roleNet.set(role, (roleNet.get(role) ?? 0n) + l.debit - l.credit);
  }
  return {
    roleCounts,
    roleNet,
    hasInvoiceNumber: entry.invoiceNumbers.length > 0,
    hasBillNumber: entry.billNumbers.length > 0,
    hasCustomer: !!entry.customerId,
  };
}

export function classifyEntries(entries: Entry[], accounts: Map<string, Account>, rules: readonly ClassificationRule[]): void {
  for (const e of entries) {
    if (e.debitTotal !== e.creditTotal) {
      e.type = "journal";
      e.ruleId = "unbalanced";
      e.why = "This entry's debits and credits don't agree, so it can only be kept as a journal entry for review.";
      continue;
    }
    if (e.debitTotal === 0n) {
      e.type = "journal";
      e.ruleId = "zero-amount";
      e.why = "Has no amount (every line is zero), so it is kept as a journal entry for the record.";
      continue;
    }
    const c = classify(rules, shapeOf(e, accounts));
    e.type = c.type;
    e.ruleId = c.ruleId;
    e.why = c.why;
  }
}

/**
 * Pair the two legs of transfers that meet in a Transfer Clearing account. A leg
 * into clearing (money out of an account) pairs with a leg out of clearing (money
 * into another account) of the same amount, on the same date if possible, else
 * within `windowDays` when the match is unique. Paired legs become a transfer or a
 * credit card payment; unpaired legs stay as journal entries with a Review card.
 */
export function pairTransferLegs(
  entries: Entry[],
  accounts: Map<string, Account>,
  resolutions: Record<string, string>,
  exponent: number,
  windowDays = 3,
): Issue[] {
  interface Leg { e: Entry; amount: Minor; out: boolean; moneyRole: Role; date: number }
  const legs: Leg[] = [];
  for (const e of entries) {
    if (e.type !== "transfer-leg") continue;
    let clearing = 0n;
    let moneyRole: Role = "bank";
    for (const l of e.lines) {
      const a = accounts.get(l.accountId)!;
      if (a.role === "transferClearing") clearing += l.debit - l.credit;
      else moneyRole = a.role;
    }
    // Clearing debited = money left the bank/card account ("out" leg).
    legs.push({ e, amount: clearing < 0n ? -clearing : clearing, out: clearing > 0n, moneyRole, date: Date.parse(e.date) });
  }

  const outs = legs.filter((l) => l.out);
  const ins = legs.filter((l) => !l.out);
  const used = new Set<Leg>();
  const pair = (o: Leg, i: Leg) => {
    used.add(o);
    used.add(i);
    const type = o.moneyRole === "bank" && i.moneyRole === "creditCard" ? "credit-card-payment" : "transfer";
    const why = type === "credit-card-payment"
      ? "A bank account paid down a credit card. Wave recorded it as two entries meeting in Transfer Clearing; they are paired here as one payment."
      : "Money moved between two accounts. Wave recorded it as two entries meeting in Transfer Clearing; they are paired here as one transfer.";
    for (const [a, b] of [[o, i], [i, o]] as const) {
      a.e.type = type;
      a.e.pairedWith = b.e.id;
      a.e.why = why;
    }
  };

  // Answers from Review first.
  const byId = new Map(legs.map((l) => [l.e.id, l] as const));
  for (const l of legs) {
    const answer = resolutions[`unpaired-transfer:${l.e.id}`];
    const other = answer ? byId.get(answer) : undefined;
    if (other && !used.has(l) && !used.has(other) && other.out !== l.out) pair(l.out ? l : other, l.out ? other : l);
  }
  // Same date, same amount: pair in ID order.
  for (const o of outs) {
    if (used.has(o)) continue;
    const i = ins.find((x) => !used.has(x) && x.amount === o.amount && x.date === o.date && x.e.id !== o.e.id);
    if (i) pair(o, i);
  }
  // Nearby date, same amount, unique both ways.
  const day = 86_400_000;
  for (const o of outs) {
    if (used.has(o)) continue;
    const near = ins.filter((x) => !used.has(x) && x.amount === o.amount && Math.abs(x.date - o.date) <= windowDays * day);
    if (near.length !== 1) continue;
    const back = outs.filter((x) => !used.has(x) && x.amount === o.amount && Math.abs(x.date - near[0]!.date) <= windowDays * day);
    if (back.length === 1) pair(o, near[0]!);
  }

  const issues: Issue[] = [];
  for (const l of legs) {
    if (used.has(l)) continue;
    l.e.type = "journal";
    l.e.why = "One side of a transfer whose other side wasn't found, so it is kept as a journal entry.";
    const candidates = (l.out ? ins : outs).filter((x) => !used.has(x) && x.amount === l.amount);
    const acct = l.e.lines.map((x) => accounts.get(x.accountId)!).find((a) => a.role !== "transferClearing");
    issues.push({
      id: `unpaired-transfer:${l.e.id}`,
      kind: "unpaired-transfer",
      severity: "amber",
      title: `Transfer on ${l.e.date} has no matching other side`,
      explanation: `${formatPlain(l.amount, exponent)} moved ${l.out ? "out of" : "into"} ${acct?.name ?? "an account"} through Transfer Clearing, but no entry moving the same amount ${l.out ? "into" : "out of"} another account was found nearby. Pick the matching entry, or keep it as a journal entry.`,
      options: [
        ...candidates.map((c) => ({ value: c.e.id, label: `${c.e.date}: ${c.e.description}` })),
        { value: "keep-journal", label: "Keep as a journal entry" },
      ],
      refs: [l.e.id],
    });
  }
  return issues;
}
