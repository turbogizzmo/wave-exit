import { abs, formatPlain, parseAmount, sum, type Minor } from "../money.ts";
import type { WaveSnapshot } from "../readers/wave-api/snapshot.ts";
import type { Account, AgingBucket, AgingRow, Entry, Issue, OpenDocument, PaymentApplication } from "./types.ts";

/**
 * Invoices and bills with their payments linked, rebuilt from the ledger and, when
 * connected, checked against Wave's invoices. Payments link to ledger entries by the
 * Transaction ID Wave gives each invoice payment; otherwise by invoice number, date
 * and amount; in export-file-only mode by invoice number on the ledger lines.
 */

export interface OpenItemsResult {
  invoices: OpenDocument[];
  bills: OpenDocument[];
  payments: PaymentApplication[];
  issues: Issue[];
}

interface Ctx {
  entries: Entry[];
  accounts: Map<string, Account>;
  exponent: number;
  fmt: (v: Minor) => string;
}

/** Receivable (or payable) lines of an entry that carry a given document number, signed debit-positive. */
function docLines(e: Entry, ctx: Ctx, role: "receivable" | "payable", number: string): Minor {
  return sum(
    e.lines
      .filter((l) => ctx.accounts.get(l.accountId)!.role === role && (role === "receivable" ? l.invoiceNumber : l.billNumber) === number)
      .map((l) => l.debit - l.credit),
  );
}

function moneyAccountOf(e: Entry, ctx: Ctx): string {
  return e.lines.find((l) => {
    const r = ctx.accounts.get(l.accountId)!.role;
    return r === "bank" || r === "creditCard";
  })?.accountId ?? "";
}

function moneyMoved(e: Entry, ctx: Ctx): Minor {
  return abs(sum(e.lines.filter((l) => { const r = ctx.accounts.get(l.accountId)!.role; return r === "bank" || r === "creditCard"; }).map((l) => l.debit - l.credit)));
}

function status(total: Minor, paid: Minor): OpenDocument["status"] {
  if (paid === 0n) return "unpaid";
  if (paid === total) return "paid";
  return paid > total ? "overpaid" : "partial";
}

export function buildOpenItems(entries: Entry[], accounts: Map<string, Account>, snapshot: WaveSnapshot | undefined, exponent: number): OpenItemsResult {
  const ctx: Ctx = { entries, accounts, exponent, fmt: (v) => formatPlain(v, exponent) };
  const issues: Issue[] = [];
  const payments: PaymentApplication[] = [];

  // Ledger view: per invoice number, the entries that raise it and the ones that pay it.
  const raised = new Map<string, Entry[]>();
  const paidBy = new Map<string, Entry[]>();
  for (const e of entries) {
    for (const n of e.invoiceNumbers) {
      const net = docLines(e, ctx, "receivable", n);
      if (net > 0n) push(raised, n, e);
      else if (net < 0n) push(paidBy, n, e);
    }
  }

  const invoices: OpenDocument[] = [];
  const claimed = new Set<string>(); // `${entryId}|${number}` already applied to a document

  if (snapshot) {
    const byLedgerId = new Map(entries.map((e) => [e.id, e] as const));
    for (const inv of snapshot.invoices) {
      if (inv.status === "DRAFT" || inv.status === "SAVED") continue; // never posted to the ledger
      const total = parseAmount(inv.total, exponent);
      const wave = { total, amountPaid: parseAmount(inv.amountPaid, exponent), amountDue: parseAmount(inv.amountDue, exponent), status: inv.status };
      const ledgerTotal = sum((raised.get(inv.number) ?? []).map((e) => docLines(e, ctx, "receivable", inv.number)));
      const doc: OpenDocument = {
        id: `wave:${inv.id}`, kind: "invoice", number: inv.number, contactId: inv.customerId ? `wave:${inv.customerId}` : "",
        date: inv.date, dueDate: inv.dueDate, dueDateKnown: true, total: ledgerTotal || total,
        amountPaid: 0n, amountDue: 0n, wave, status: "unpaid",
        entryIds: (raised.get(inv.number) ?? []).map((e) => e.id), payments: [], waveId: inv.id,
      };
      for (const p of inv.payments) {
        if (!p.active) continue;
        const amount = parseAmount(p.amount, exponent);
        let entry = p.ledgerTransactionId ? byLedgerId.get(p.ledgerTransactionId) : undefined;
        let linkedBy: PaymentApplication["linkedBy"] = "wave-id";
        if (!entry) {
          const candidates = (paidBy.get(inv.number) ?? []).filter(
            (e) => !claimed.has(`${e.id}|${inv.number}`) && e.date === p.date && -docLines(e, ctx, "receivable", inv.number) === amount,
          );
          if (candidates.length === 1) {
            entry = candidates[0];
            linkedBy = "invoice-date-amount";
          }
        }
        if (!entry) {
          issues.push({
            id: `payment-unlinked:${p.id}`,
            kind: "payment-unlinked",
            severity: "amber",
            title: `Invoice ${inv.number}: a payment in Wave wasn't found in the export`,
            explanation: `Wave records a payment of ${ctx.fmt(amount)} on ${p.date} against invoice ${inv.number}, but no matching entry is in the transactions export. If it was recorded after the export was made, request a fresh export.`,
            options: [],
            refs: [doc.id],
          });
          continue;
        }
        claimed.add(`${entry.id}|${inv.number}`);
        const applied = -docLines(entry, ctx, "receivable", inv.number);
        doc.payments.push({
          paymentId: entry.id, entryId: entry.id, date: entry.date, contactId: doc.contactId,
          bankAccountId: moneyAccountOf(entry, ctx), amount: moneyMoved(entry, ctx),
          appliedToType: "invoice", appliedToNumber: inv.number, appliedAmount: applied, linkedBy, wavePaymentId: p.id,
        });
      }
      // Ledger payments against this number that Wave's invoice doesn't list.
      for (const e of paidBy.get(inv.number) ?? []) {
        if (claimed.has(`${e.id}|${inv.number}`)) continue;
        claimed.add(`${e.id}|${inv.number}`);
        doc.payments.push(ledgerPayment(e, ctx, "invoice", inv.number, doc.contactId));
        issues.push({
          id: `invoice-mismatch:extra-payment:${inv.id}:${e.id}`,
          kind: "invoice-mismatch",
          severity: "amber",
          title: `Invoice ${inv.number}: the export has a payment Wave's invoice doesn't list`,
          explanation: `The entry on ${e.date} ("${e.description}") reduces the receivable for invoice ${inv.number} by ${ctx.fmt(-docLines(e, ctx, "receivable", inv.number))}, but Wave's invoice doesn't list that payment. It is counted as a payment.`,
          options: [],
          refs: [doc.id, e.id],
        });
      }
      finish(doc);
      if (ledgerTotal !== 0n && ledgerTotal !== total) {
        issues.push(mismatch(doc, `Wave says invoice ${inv.number} totals ${ctx.fmt(total)}, but the ledger entry for it totals ${ctx.fmt(ledgerTotal)}.`));
      }
      if (doc.amountDue !== wave.amountDue) {
        issues.push(mismatch(doc, `Wave says ${ctx.fmt(wave.amountDue)} is still owed on invoice ${inv.number}, but the payments found in the export total ${ctx.fmt(doc.amountPaid)} against ${ctx.fmt(doc.total)}, leaving ${ctx.fmt(doc.amountDue)}.`));
      }
      invoices.push(doc);
    }
    // Invoice numbers in the ledger that Wave doesn't know.
    const known = new Set(snapshot.invoices.map((i) => i.number));
    for (const [n, es] of raised) {
      if (known.has(n)) continue;
      const doc = ledgerDocument("invoice", n, es, paidBy.get(n) ?? [], ctx, claimed);
      invoices.push(doc);
      issues.push(mismatch(doc, `Invoice ${n} is in the export but not in Wave's invoice list. It may have been deleted in Wave after the export.`));
    }
  } else {
    for (const [n, es] of raised) invoices.push(ledgerDocument("invoice", n, es, paidBy.get(n) ?? [], ctx, claimed));
  }

  // Bills: ledger only (Wave's API has no bills). Format unverified against a real export.
  const billRaised = new Map<string, Entry[]>();
  const billPaid = new Map<string, Entry[]>();
  for (const e of entries) {
    for (const n of e.billNumbers) {
      const net = docLines(e, ctx, "payable", n);
      if (net < 0n) push(billRaised, n, e);
      else if (net > 0n) push(billPaid, n, e);
    }
  }
  const bills: OpenDocument[] = [];
  for (const [n, es] of billRaised) bills.push(ledgerDocument("bill", n, es, billPaid.get(n) ?? [], ctx, claimed));

  // Payments against numbers that were never raised in the ledger.
  for (const [map, kind] of [[paidBy, "invoice"], [billPaid, "bill"]] as const) {
    for (const [n, es] of map) {
      for (const e of es) {
        if (claimed.has(`${e.id}|${n}`)) continue;
        issues.push({
          id: `payment-unlinked:${kind}:${n}:${e.id}`,
          kind: "payment-unlinked",
          severity: "amber",
          title: `A payment refers to ${kind} ${n}, which isn't in the books`,
          explanation: `The entry on ${e.date} ("${e.description}") is a payment against ${kind} ${n}, but no ${kind} with that number was found. It stays in the ledger but isn't applied to any ${kind}.`,
          options: [],
          refs: [e.id],
        });
      }
    }
  }

  // Receivable or payable movements with no document number: credits, overpayments, write-offs.
  for (const [role, kind] of [["receivable", "unlinked-receivable"], ["payable", "unlinked-payable"]] as const) {
    const loose = entries.filter((e) => e.lines.some((l) => ctx.accounts.get(l.accountId)!.role === role && !(role === "receivable" ? l.invoiceNumber : l.billNumber)));
    if (!loose.length) continue;
    issues.push({
      id: `${kind}`,
      kind,
      severity: "amber",
      title: `${loose.length} ${role === "receivable" ? "receivable" : "payable"} ${loose.length === 1 ? "entry has" : "entries have"} no ${role === "receivable" ? "invoice" : "bill"} number`,
      explanation: `These entries change accounts ${role === "receivable" ? "receivable" : "payable"} without naming a document, such as customer credits, overpayments or write-offs. They stay in the ledger; choose whether to keep them as unapplied credits.`,
      options: [{ value: "keep-as-credits", label: "Keep as unapplied credits" }],
      refs: loose.map((e) => e.id),
    });
  }

  for (const d of [...invoices, ...bills]) payments.push(...d.payments);
  payments.sort((a, b) => a.date.localeCompare(b.date) || a.paymentId.localeCompare(b.paymentId) || a.appliedToNumber.localeCompare(b.appliedToNumber));
  return { invoices: sortDocs(invoices), bills: sortDocs(bills), payments, issues };

  function finish(doc: OpenDocument) {
    doc.amountPaid = sum(doc.payments.map((p) => p.appliedAmount));
    doc.amountDue = doc.total - doc.amountPaid;
    doc.status = status(doc.total, doc.amountPaid);
  }

  function mismatch(doc: OpenDocument, explanation: string): Issue {
    return {
      id: `invoice-mismatch:${doc.id}:${issues.length}`,
      kind: "invoice-mismatch",
      severity: "amber",
      title: `Invoice ${doc.number}: the amounts don't agree`,
      explanation,
      options: [],
      refs: [doc.id, ...doc.entryIds, ...doc.payments.map((p) => p.entryId)],
    };
  }
}

function ledgerPayment(e: Entry, ctx: Ctx, kind: "invoice" | "bill", n: string, contactId: string): PaymentApplication {
  const net = docLines(e, ctx, kind === "invoice" ? "receivable" : "payable", n);
  return {
    paymentId: e.id, entryId: e.id, date: e.date, contactId,
    bankAccountId: moneyAccountOf(e, ctx), amount: moneyMoved(e, ctx),
    appliedToType: kind, appliedToNumber: n, appliedAmount: kind === "invoice" ? -net : net,
    linkedBy: "ledger-number", wavePaymentId: "",
  };
}

function ledgerDocument(kind: "invoice" | "bill", n: string, raisedBy: Entry[], paidBy: Entry[], ctx: Ctx, claimed: Set<string>): OpenDocument {
  const role = kind === "invoice" ? "receivable" : "payable";
  const sign = kind === "invoice" ? 1n : -1n;
  const first = raisedBy[0]!;
  const contactId = kind === "invoice" ? (raisedBy.find((e) => e.customerId)?.customerId ?? "") : (raisedBy.find((e) => e.vendorId)?.vendorId ?? "");
  const total = sign * sum(raisedBy.map((e) => docLines(e, ctx, role, n)));
  const payments = paidBy.filter((e) => !claimed.has(`${e.id}|${n}`)).map((e) => {
    claimed.add(`${e.id}|${n}`);
    return ledgerPayment(e, ctx, kind, n, contactId);
  });
  const amountPaid = sum(payments.map((p) => p.appliedAmount));
  return {
    id: kind === "invoice" ? `export-invoice:${n}` : `export-bill:${contactId}:${n}`,
    kind, number: n, contactId, date: first.date, dueDate: first.date, dueDateKnown: false,
    total, amountPaid, amountDue: total - amountPaid, status: status(total, amountPaid),
    entryIds: raisedBy.map((e) => e.id), payments, waveId: "",
  };
}

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
};

const sortDocs = (d: OpenDocument[]) => d.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number, undefined, { numeric: true }));

/**
 * Open documents and what was owed on each at a date: payments after the date
 * don't count, documents dated after it are left out.
 */
export function agingAt(docs: readonly OpenDocument[], asOf: string): AgingRow[] {
  const at = Date.parse(asOf);
  const rows: AgingRow[] = [];
  for (const d of docs) {
    if (d.date > asOf) continue;
    const paid = sum(d.payments.filter((p) => p.date <= asOf).map((p) => p.appliedAmount));
    const due = d.total - paid;
    if (due === 0n) continue;
    const days = Math.floor((at - Date.parse(d.dueDate)) / 86_400_000);
    rows.push({
      documentId: d.id, kind: d.kind, number: d.number, contactId: d.contactId, date: d.date, dueDate: d.dueDate,
      dueDateKnown: d.dueDateKnown, amountDue: due, daysPastDue: Math.max(0, days), bucket: bucketFor(days),
    });
  }
  return rows;
}

export function bucketFor(daysPastDue: number): AgingBucket {
  if (daysPastDue <= 0) return "current";
  if (daysPastDue <= 30) return "1-30";
  if (daysPastDue <= 60) return "31-60";
  if (daysPastDue <= 90) return "61-90";
  return "90+";
}
