import { formatPlain, sum, type Minor } from "../../money.ts";
import { scopedLedger, OPENING_ENTRY_ID } from "../../model/opening.ts";
import { agingAt } from "../../model/open-items.ts";
import { trialBalance } from "../../model/ledger.ts";
import type { Account, Books, Contact, Entry, Line, OpenDocument, PaymentApplication } from "../../model/types.ts";
import { defaultMapping, qboName, type AccountMapping, type QboAccount } from "./accounts.ts";

/**
 * The load plan: everything that will be created in QuickBooks, in the brief's
 * order (accounts → contacts → items → invoices and bills → payments → bank and
 * card transactions → journals), each with a stable key so a resumed or repeated
 * run never creates it twice. Built from the books' classification, so QuickBooks
 * gets real transaction types: banking, vendor and sales reports work.
 *
 * Every operation also records what it posts to each account, so the preview can
 * prove the plan carries exactly the ledger (`checkPlan`).
 */

export type QboEntity =
  | "Account" | "Customer" | "Vendor" | "Item" | "Invoice" | "Bill" | "Payment" | "BillPayment"
  | "Purchase" | "Deposit" | "SalesReceipt" | "Transfer" | "CreditCardPayment" | "JournalEntry";

export const PHASES = [
  "Accounts", "Customers and vendors", "Products and services", "Invoices and bills", "Payments",
  "Bank and card transactions", "Journal entries",
] as const;

/** Resolves a plan key to the QuickBooks ID of the object it made (or was mapped to). */
export type IdOf = (key: string) => string;

export interface LoadOp {
  key: string;
  entity: QboEntity;
  phase: number;
  /** For people: "Invoice 1002 for Cedar & Co". */
  label: string;
  date: string;
  /** Wave entries this operation carries. */
  waveRefs: string[];
  /** Keys this operation refers to (must exist first). */
  needs: string[];
  build(id: IdOf): Record<string, unknown>;
  /** What it posts: Wave Exit account ID → debit − credit. */
  postings: [string, Minor][];
}

export interface ExistingCompany {
  accounts: QboAccount[];
  customers: { Id: string; DisplayName: string; Active?: boolean }[];
  vendors: { Id: string; DisplayName: string; Active?: boolean }[];
  items: { Id: string; Name: string; Active?: boolean; Type?: string; IncomeAccountRef?: { value: string } }[];
}

export interface PlanOptions {
  /** Mapping-screen overrides: Wave Exit account ID → QuickBooks account ID, or "create". */
  accountOverrides?: Record<string, string>;
}

export interface LoadPlan {
  ops: LoadOp[];
  mapping: AccountMapping;
  /** Keys already present in the company (mapped accounts, matched contacts and items) → QuickBooks ID. */
  existing: Map<string, string>;
  /** Entries left out, and why. */
  skipped: { entryId: string; why: string }[];
  scope: Books["settings"]["scope"];
}

const PLACEHOLDER_CUSTOMER = "contact:placeholder-customer";
const PLACEHOLDER_VENDOR = "contact:placeholder-vendor";
const OPENING_ITEM = "item:opening-balance";

export function buildLoadPlan(books: Books, company: ExistingCompany, opts: PlanOptions = {}): LoadPlan {
  const exp = books.business.exponent;
  const n = (v: Minor) => Number(formatPlain(v, exp));
  const scoped = scopedLedger(books);
  const allAccounts = [...books.accounts, ...scoped.extraAccounts];
  const acc = new Map(allAccounts.map((a) => [a.id, a] as const));
  const contacts = new Map(books.contacts.map((c) => [c.id, c] as const));
  const ops: LoadOp[] = [];
  const skipped: LoadPlan["skipped"] = [];
  const existing = new Map<string, string>();
  const role = (l: Line) => acc.get(l.accountId)!.role;
  const isMoney = (l: Line) => role(l) === "bank" || role(l) === "creditCard";
  const note = (e: { id: string; description?: string }, extra = "") => `Wave #${e.id}${extra}${e.description ? ` – ${e.description}` : ""}`.slice(0, 4000);

  // ---- accounts: only those the load touches ---------------------------------
  const used = new Set<string>();
  for (const e of scoped.entries) for (const l of e.lines) used.add(l.accountId);
  const usedAccounts = allAccounts.filter((a) => used.has(a.id));
  const mapping = defaultMapping(usedAccounts, company.accounts, opts.accountOverrides);
  const akey = (accountId: string) => `account:${accountId}`;
  for (const a of usedAccounts) {
    const c = mapping.choices.get(a.id)!;
    if (c.kind === "existing") {
      existing.set(akey(a.id), c.qboId);
      continue;
    }
    ops.push({
      key: akey(a.id), entity: "Account", phase: 0, label: `Account “${c.name}”`, date: "", waveRefs: [], needs: [], postings: [],
      build: () => ({ Name: c.name, AccountType: c.type.AccountType, AccountSubType: c.type.AccountSubType, ...(a.description ? { Description: a.description.slice(0, 100) } : {}) }),
    });
  }
  const ref = (id: IdOf, accountId: string) => ({ value: id(akey(accountId)) });

  // ---- contacts ---------------------------------------------------------------
  const takenDisplay = new Set([...company.customers.map((c) => c.DisplayName.toLowerCase()), ...company.vendors.map((v) => v.DisplayName.toLowerCase())]);
  const custByName = new Map(company.customers.filter((c) => c.Active !== false).map((c) => [c.DisplayName.toLowerCase(), c.Id] as const));
  const vendByName = new Map(company.vendors.filter((v) => v.Active !== false).map((v) => [v.DisplayName.toLowerCase(), v.Id] as const));
  const neededContacts = new Set<string>();
  const ckey = (contactId: string) => `contact:${contactId}`;
  const contactOp = (key: string, role: "customer" | "vendor", name: string, c?: Contact) => {
    const display = qboName(name, 500);
    const match = (role === "customer" ? custByName : vendByName).get(display.toLowerCase());
    if (match) {
      existing.set(key, match);
      return;
    }
    let unique = display;
    for (let i = 2; takenDisplay.has(unique.toLowerCase()); i++) unique = qboName(`${name} (${role === "customer" ? "customer" : "vendor"}${i > 2 ? ` ${i - 1}` : ""})`, 500);
    takenDisplay.add(unique.toLowerCase());
    ops.push({
      key, entity: role === "customer" ? "Customer" : "Vendor", phase: 1, label: `${role === "customer" ? "Customer" : "Vendor"} “${unique}”`, date: "", waveRefs: [], needs: [], postings: [],
      build: () => ({
        DisplayName: unique,
        ...(c?.email ? { PrimaryEmailAddr: { Address: c.email } } : {}),
        ...(c?.phone ? { PrimaryPhone: { FreeFormNumber: c.phone } } : {}),
        ...(c?.address ? { BillAddr: { Line1: c.address.line1, Line2: c.address.line2, City: c.address.city, CountrySubDivisionCode: c.address.province, PostalCode: c.address.postalCode, Country: c.address.country } } : {}),
      }),
    });
  };
  /** The contact key a transaction refers to, decided at planning time so the contact is created first. */
  const contactKey = (contactId: string, wantRole: "customer" | "vendor") => {
    const key = contactId && contacts.get(contactId)?.role === wantRole ? ckey(contactId) : wantRole === "customer" ? PLACEHOLDER_CUSTOMER : PLACEHOLDER_VENDOR;
    neededContacts.add(key);
    return key;
  };
  /** Whom a line or entry is about, for an AR/AP journal line. */
  const lineContactKey = (e: Entry, l: Line, want: "customer" | "vendor") => {
    const cid = want === "customer" ? l.customerId || e.customerId : l.vendorId || e.vendorId;
    return cid && contacts.get(cid)?.role === want ? ckey(cid) : want === "customer" ? PLACEHOLDER_CUSTOMER : PLACEHOLDER_VENDOR;
  };

  // ---- items: one service item per income account used on sales forms ---------
  const items = new Map<string, string>(); // item key → account id
  // Every existing name counts, inactive ones too: QuickBooks keeps them reserved.
  const itemNames = new Set(company.items.map((i) => i.Name.toLowerCase()));
  const itemFor = (accountId: string) => {
    const key = accountId === "opening" ? OPENING_ITEM : `item:${accountId}`;
    items.set(key, accountId);
    return key;
  };

  // ---- documents --------------------------------------------------------------
  const scopeOpening = scoped.scope === "opening-balances";
  const cutover = books.period.cutoverDate;
  const openAtCutover = new Map([...agingAt(books.invoices, cutover), ...agingAt(books.bills, cutover)].map((r) => [r.documentId, r.amountDue] as const));
  const entryIds = new Set(scoped.entries.map((e) => e.id));
  const byEntry = new Map(books.entries.map((e) => [e.id, e] as const));
  const handled = new Set<string>(); // entries carried by a document op
  const dkey = (docId: string) => `doc:${docId}`;
  const loadedDocs = new Set<string>();

  for (const d of [...books.invoices, ...books.bills]) {
    const before = d.date <= cutover;
    if (scopeOpening && before) {
      const due = openAtCutover.get(d.id) ?? 0n;
      if (due <= 0n) continue;
      loadedDocs.add(d.id);
      ops.push(openingDocOp(d, due));
      continue;
    }
    if (!d.entryIds.some((id) => entryIds.has(id))) continue;
    loadedDocs.add(d.id);
    for (const id of d.entryIds) handled.add(id);
    ops.push(docOp(d));
  }

  function docLinesFor(d: OpenDocument): { accountId: string; amount: Minor; description: string; qty?: string; price?: string }[] {
    const role = d.kind === "invoice" ? "receivable" : "payable";
    const sign = d.kind === "invoice" ? 1n : -1n;
    // Ledger lines: exact by construction.
    const ledger: { accountId: string; amount: Minor; description: string }[] = [];
    for (const id of d.entryIds) {
      const e = byEntry.get(id);
      if (!e) continue;
      for (const l of e.lines) if (acc.get(l.accountId)!.role !== role) ledger.push({ accountId: l.accountId, amount: sign * (l.credit - l.debit), description: l.description || e.description });
    }
    // Prefer Wave's line items (descriptions, quantities) when they add up to the same total on the same accounts.
    if (d.linesFrom === "wave" && d.lines.length) {
      const taxAccount = ledger.find((l) => acc.get(l.accountId)?.role === "salesTax")?.accountId;
      const wave = d.lines.map((l) => ({ accountId: l.accountId, amount: l.amount, description: l.description, qty: l.quantity, price: l.unitPrice }));
      const tax = sum(d.lines.map((l) => l.taxAmount));
      const lines = tax && taxAccount ? [...wave, { accountId: taxAccount, amount: tax, description: "Sales tax" }] : wave;
      const totals = (xs: { accountId: string; amount: Minor }[]) => {
        const m = new Map<string, Minor>();
        for (const x of xs) m.set(x.accountId, (m.get(x.accountId) ?? 0n) + x.amount);
        return [...m].filter(([, v]) => v !== 0n).sort().join("|");
      };
      if (lines.every((l) => acc.has(l.accountId)) && totals(lines) === totals(ledger)) return lines;
    }
    return ledger;
  }

  function docOp(d: OpenDocument): LoadOp {
    const lines = docLinesFor(d);
    const who = contactKey(d.contactId, d.kind === "invoice" ? "customer" : "vendor");
    const controlAccount = d.kind === "invoice"
      ? byEntry.get(d.entryIds[0]!)?.lines.find((l) => acc.get(l.accountId)!.role === "receivable")?.accountId
      : byEntry.get(d.entryIds[0]!)?.lines.find((l) => acc.get(l.accountId)!.role === "payable")?.accountId;
    const postings: [string, Minor][] = lines.map((l) => [l.accountId, d.kind === "invoice" ? -l.amount : l.amount]);
    if (controlAccount) postings.push([controlAccount, d.kind === "invoice" ? d.total : -d.total]);
    if (d.kind === "invoice") for (const l of lines) neededItem(l.accountId);
    const docNumber = d.number.length <= 21 ? d.number : "";
    return {
      key: dkey(d.id), entity: d.kind === "invoice" ? "Invoice" : "Bill", phase: 3, date: d.date,
      label: `${d.kind === "invoice" ? "Invoice" : "Bill"} ${d.number}`, waveRefs: d.entryIds, postings,
      needs: [who, ...(d.kind === "invoice" ? lines.map((l) => `item:${l.accountId}`) : lines.map((l) => akey(l.accountId))), ...(controlAccount ? [akey(controlAccount)] : [])],
      build: (id) => {
        const common = {
          TxnDate: d.date, ...(d.dueDateKnown ? { DueDate: d.dueDate } : {}), ...(docNumber ? { DocNumber: docNumber } : {}),
          PrivateNote: note({ id: d.entryIds.join(", ") }, docNumber ? "" : ` (Wave number ${d.number})`),
          ...(controlAccount ? { [d.kind === "invoice" ? "ARAccountRef" : "APAccountRef"]: ref(id, controlAccount) } : {}),
        };
        if (d.kind === "invoice") {
          return {
            ...common, CustomerRef: { value: id(who) },
            // Never let QuickBooks email historical invoices to customers (Intuit: imported
            // invoices are auto-sent when online card/bank payment is enabled).
            AllowOnlineCreditCardPayment: false, AllowOnlineACHPayment: false,
            Line: lines.map((l) => ({
              DetailType: "SalesItemLineDetail", Amount: n(l.amount), ...(l.description ? { Description: l.description.slice(0, 4000) } : {}),
              SalesItemLineDetail: { ItemRef: { value: id(`item:${l.accountId}`) }, ...qtyPrice(l) },
            })),
          };
        }
        return {
          ...common, VendorRef: { value: id(who) },
          Line: lines.map((l) => ({
            DetailType: "AccountBasedExpenseLineDetail", Amount: n(l.amount), ...(l.description ? { Description: l.description.slice(0, 4000) } : {}),
            AccountBasedExpenseLineDetail: { AccountRef: ref(id, l.accountId) },
          })),
        };
      },
    };
    function qtyPrice(l: { amount: Minor; qty?: string; price?: string }) {
      if (!l.qty || !l.price) return {};
      const q = Number(l.qty);
      const p = Number(l.price);
      return Number.isFinite(q) && Number.isFinite(p) && Math.round(q * p * 100) === Math.round(n(l.amount) * 100) ? { Qty: q, UnitPrice: p } : {};
    }
  }

  /** Opening-balances scope: an open document carried with its remaining amount against Opening Balance Equity. */
  function openingDocOp(d: OpenDocument, due: Minor): LoadOp {
    const obe = "wave-exit:opening-balance-equity";
    const control = allAccounts.find((a) => a.role === (d.kind === "invoice" ? "receivable" : "payable"))?.id;
    if (d.kind === "invoice") itemFor("opening");
    const who = contactKey(d.contactId, d.kind === "invoice" ? "customer" : "vendor");
    const postings: [string, Minor][] = [[obe, d.kind === "invoice" ? -due : due]];
    if (control) postings.push([control, d.kind === "invoice" ? due : -due]);
    return {
      key: dkey(d.id), entity: d.kind === "invoice" ? "Invoice" : "Bill", phase: 3, date: d.date,
      label: `Open ${d.kind} ${d.number} (balance at cutover)`, waveRefs: [], postings,
      needs: [who, d.kind === "invoice" ? OPENING_ITEM : akey(obe)],
      build: (id) => {
        const line = d.kind === "invoice"
          ? { DetailType: "SalesItemLineDetail", Amount: n(due), Description: `Balance owed at ${cutover} on Wave invoice ${d.number}`, SalesItemLineDetail: { ItemRef: { value: id(OPENING_ITEM) } } }
          : { DetailType: "AccountBasedExpenseLineDetail", Amount: n(due), Description: `Balance owed at ${cutover} on Wave bill ${d.number}`, AccountBasedExpenseLineDetail: { AccountRef: ref(id, obe) } };
        return {
          TxnDate: d.date, ...(d.dueDateKnown ? { DueDate: d.dueDate } : {}), ...(d.number.length <= 21 ? { DocNumber: d.number } : {}),
          PrivateNote: `Wave ${d.kind} ${d.number}: balance at cutover ${cutover}`,
          ...(d.kind === "invoice"
            ? { CustomerRef: { value: id(who) }, AllowOnlineCreditCardPayment: false, AllowOnlineACHPayment: false }
            : { VendorRef: { value: id(who) } }),
          ...(control ? { [d.kind === "invoice" ? "ARAccountRef" : "APAccountRef"]: ref(id, control) } : {}),
          Line: [line],
        };
      },
    };
  }

  function neededItem(accountId: string) {
    itemFor(accountId);
  }

  // ---- entries ----------------------------------------------------------------
  const appsByEntry = new Map<string, PaymentApplication[]>();
  for (const p of books.payments) appsByEntry.set(p.entryId, [...(appsByEntry.get(p.entryId) ?? []), p]);
  const docByNumber = new Map([...books.invoices, ...books.bills].map((d) => [`${d.kind}|${d.number}`, d] as const));
  const pairsDone = new Set<string>();

  for (const e of scoped.entries) {
    if (handled.has(e.id)) continue;
    if (e.debitTotal === 0n) {
      skipped.push({ entryId: e.id, why: "Has no amount; QuickBooks can't record a zero transaction." });
      continue;
    }
    const op = entryOp(e);
    if (op) ops.push(op);
  }

  function postingsOf(lines: readonly Line[]): [string, Minor][] {
    return lines.map((l) => [l.accountId, l.debit - l.credit]);
  }

  function entryOp(e: Entry): LoadOp | null {
    const money = e.lines.filter(isMoney);
    const others = e.lines.filter((l) => !isMoney(l));
    const base = { date: e.date, waveRefs: [e.id] };

    if ((e.type === "invoice-payment" || e.type === "bill-payment") && money.length === 1) {
      const p = paymentOps(e);
      if (p) return p;
    }

    if ((e.type === "expense" || e.type === "refund") && money.length === 1 && others.every((l) => (e.type === "expense" ? l.debit > 0n && !l.credit : l.credit > 0n && !l.debit))) {
      const m = money[0]!;
      const card = role(m) === "creditCard";
      if (e.type === "expense" || card) {
        const vendorish = e.vendorId || e.customerId;
        const who = vendorish ? contactKey(vendorish, contacts.get(vendorish)?.role ?? "vendor") : "";
        return {
          ...base, key: `txn:${e.id}`, entity: "Purchase", phase: 5,
          label: `${e.type === "refund" ? "Card refund" : card ? "Card expense" : "Expense"} ${e.date}: ${e.description}`,
          needs: [akey(m.accountId), ...others.map((l) => akey(l.accountId)), ...(who ? [who] : [])], postings: postingsOf(e.lines),
          build: (id) => ({
            PaymentType: card ? "CreditCard" : "Cash", AccountRef: ref(id, m.accountId), TxnDate: e.date, PrivateNote: note(e),
            ...(e.type === "refund" ? { Credit: true } : {}),
            ...(who ? { EntityRef: { value: id(who), type: contacts.get(vendorish)?.role === "customer" ? "Customer" : "Vendor" } } : {}),
            Line: others.map((l) => ({
              DetailType: "AccountBasedExpenseLineDetail", Amount: n(e.type === "refund" ? l.credit : l.debit),
              ...(l.description ? { Description: l.description } : {}),
              AccountBasedExpenseLineDetail: { AccountRef: ref(id, l.accountId) },
            })),
          }),
        };
      }
      // Bank refund: Intuit allows Purchase credits only on cards, so record it as a deposit.
      return depositOp(e, m, others);
    }

    if ((e.type === "deposit" || e.type === "sales-receipt") && money.length === 1 && role(money[0]!) === "bank" && others.every((l) => l.credit > 0n && !l.debit)) {
      const m = money[0]!;
      if (e.type === "sales-receipt" && e.customerId && others.every((l) => role(l) === "income")) {
        for (const l of others) neededItem(l.accountId);
        const who = contactKey(e.customerId, "customer");
        return {
          ...base, key: `txn:${e.id}`, entity: "SalesReceipt", phase: 5, label: `Sales receipt ${e.date}: ${e.description}`,
          needs: [akey(m.accountId), who, ...others.map((l) => `item:${l.accountId}`)], postings: postingsOf(e.lines),
          build: (id) => ({
            CustomerRef: { value: id(who) }, TxnDate: e.date, DepositToAccountRef: ref(id, m.accountId), PrivateNote: note(e),
            Line: others.map((l) => ({ DetailType: "SalesItemLineDetail", Amount: n(l.credit), ...(l.description ? { Description: l.description } : {}), SalesItemLineDetail: { ItemRef: { value: id(`item:${l.accountId}`) } } })),
          }),
        };
      }
      return depositOp(e, m, others);
    }

    if (e.type === "transfer" || e.type === "credit-card-payment") {
      // Two legs through Transfer Clearing become one QuickBooks transaction.
      const legs = e.pairedWith ? [e, byEntry.get(e.pairedWith)!] : [e];
      const pairKey = legs.map((x) => x.id).sort().join("+");
      if (pairsDone.has(pairKey)) return null;
      pairsDone.add(pairKey);
      if (legs.length === 2 && !legs.every((x) => entryIds.has(x.id))) return journalOp(e);
      const lines = legs.flatMap((x) => x.lines).filter(isMoney);
      const from = lines.find((l) => l.credit > 0n);
      const to = lines.find((l) => l.debit > 0n);
      if (lines.length === 2 && from && to && from.credit === to.debit) {
        const amount = from.credit;
        const all = legs.flatMap((x) => x.lines);
        const r = { ...base, key: `txn:${pairKey}`, waveRefs: legs.map((x) => x.id), postings: postingsOf(all), needs: [akey(from.accountId), akey(to.accountId)] };
        if (role(from) === "bank" && role(to) === "bank") {
          return { ...r, entity: "Transfer", phase: 5, label: `Transfer ${e.date}: ${acc.get(from.accountId)!.name} → ${acc.get(to.accountId)!.name}`,
            build: (id) => ({ FromAccountRef: ref(id, from.accountId), ToAccountRef: ref(id, to.accountId), Amount: n(amount), TxnDate: e.date, PrivateNote: note({ id: pairKey, description: e.description }) }) };
        }
        if (role(from) === "bank" && role(to) === "creditCard") {
          return { ...r, entity: "CreditCardPayment", phase: 5, label: `Credit card payment ${e.date}: ${acc.get(to.accountId)!.name}`,
            build: (id) => ({ TxnDate: e.date, Amount: n(amount), BankAccountRef: ref(id, from.accountId), CreditCardAccountRef: ref(id, to.accountId), PrivateNote: note({ id: pairKey, description: e.description }) }) };
        }
      }
      // Anything else (card to bank, card to card): a journal entry carrying both legs.
      return journalOp(e, legs);
    }

    return journalOp(e);
  }

  function depositOp(e: Entry, m: Line, others: Line[]): LoadOp {
    return {
      date: e.date, waveRefs: [e.id], key: `txn:${e.id}`, entity: "Deposit", phase: 5,
      label: `${e.type === "refund" ? "Refund" : "Deposit"} ${e.date}: ${e.description}`,
      needs: [akey(m.accountId), ...others.map((l) => akey(l.accountId))], postings: postingsOf(e.lines),
      build: (id) => ({
        DepositToAccountRef: ref(id, m.accountId), TxnDate: e.date, PrivateNote: note(e),
        Line: others.map((l) => ({ DetailType: "DepositLineDetail", Amount: n(l.credit), ...(l.description ? { Description: l.description } : {}), DepositLineDetail: { AccountRef: ref(id, l.accountId) } })),
      }),
    };
  }

  /** A payment (or bill payment) linked to its documents; anything else on the entry (a processing fee) as a journal. */
  function paymentOps(e: Entry): LoadOp | null {
    const kind = e.type === "invoice-payment" ? "invoice" : "bill";
    const apps = (appsByEntry.get(e.id) ?? []).filter((a) => a.appliedToType === kind);
    const docs = apps.map((a) => docByNumber.get(`${kind}|${a.appliedToNumber}`));
    if (!apps.length || docs.some((d) => !d || !loadedDocs.has(d.id))) return null;
    const contactsInvolved = new Set(docs.map((d) => d!.contactId));
    if (contactsInvolved.size !== 1) return null;
    const m = e.lines.find(isMoney)!;
    const applied = sum(apps.map((a) => a.appliedAmount));
    const control = kind === "invoice" ? "receivable" : "payable";
    // Residual: everything except the control-account lines and the applied money.
    const residual = new Map<string, Minor>();
    for (const l of e.lines) {
      if (acc.get(l.accountId)!.role === control) continue;
      residual.set(l.accountId, (residual.get(l.accountId) ?? 0n) + l.debit - l.credit);
    }
    residual.set(m.accountId, (residual.get(m.accountId) ?? 0n) - (kind === "invoice" ? applied : -applied));
    const residualLines = [...residual].filter(([, v]) => v !== 0n);
    const paymentPostings: [string, Minor][] = [
      [m.accountId, kind === "invoice" ? applied : -applied],
      ...e.lines.filter((l) => acc.get(l.accountId)!.role === control).map((l) => [l.accountId, l.debit - l.credit] as [string, Minor]),
    ];
    const who = contactKey(docs[0]!.contactId, kind === "invoice" ? "customer" : "vendor");
    const card = role(m) === "creditCard";
    const payment: LoadOp = {
      date: e.date, waveRefs: [e.id], key: `txn:${e.id}`, entity: kind === "invoice" ? "Payment" : "BillPayment", phase: 4,
      label: `${kind === "invoice" ? "Payment for invoice" : "Payment of bill"} ${apps.map((a) => a.appliedToNumber).join(", ")}`,
      needs: [akey(m.accountId), who, ...docs.map((d) => dkey(d!.id))], postings: paymentPostings,
      build: (id) => {
        const lines = apps.map((a, i) => ({ Amount: n(a.appliedAmount), LinkedTxn: [{ TxnId: id(dkey(docs[i]!.id)), TxnType: kind === "invoice" ? "Invoice" : "Bill" }] }));
        if (kind === "invoice") {
          return { CustomerRef: { value: id(who) }, TotalAmt: n(applied), TxnDate: e.date, DepositToAccountRef: ref(id, m.accountId), PrivateNote: note(e), Line: lines };
        }
        return {
          VendorRef: { value: id(who) }, TotalAmt: n(applied), TxnDate: e.date, PrivateNote: note(e), Line: lines,
          PayType: card ? "CreditCard" : "Check",
          ...(card ? { CreditCardPayment: { CCAccountRef: ref(id, m.accountId) } } : { CheckPayment: { BankAccountRef: ref(id, m.accountId) } }),
        };
      },
    };
    if (residualLines.length) {
      ops.push({
        date: e.date, waveRefs: [], key: `txn:${e.id}:rest`, entity: "JournalEntry", phase: 6,
        label: `Rest of ${payment.label} (fees or adjustments)`, needs: residualLines.map(([a]) => akey(a)), postings: residualLines,
        build: (id) => ({
          TxnDate: e.date, PrivateNote: note(e, " (rest of payment)"),
          Line: residualLines.map(([a, v]) => ({ DetailType: "JournalEntryLineDetail", Amount: n(v < 0n ? -v : v), JournalEntryLineDetail: { PostingType: v > 0n ? "Debit" : "Credit", AccountRef: ref(id, a) } })),
        }),
      });
    }
    return payment;
  }

  function journalOp(e: Entry, legs: Entry[] = [e]): LoadOp {
    const lines = legs.flatMap((x) => x.lines.map((l) => ({ e: x, l }))).filter(({ l }) => l.debit !== l.credit);
    const key = legs.length > 1 ? `txn:${legs.map((x) => x.id).sort().join("+")}` : `txn:${e.id}`;
    const contactKeys = lines.map(({ e: x, l }) => (role(l) === "receivable" ? lineContactKey(x, l, "customer") : role(l) === "payable" ? lineContactKey(x, l, "vendor") : ""));
    for (const k of contactKeys) if (k) neededContacts.add(k);
    return {
      date: e.date, waveRefs: legs.map((x) => x.id), key, entity: "JournalEntry", phase: 6,
      label: `${e.id === OPENING_ENTRY_ID ? "Opening balances" : "Journal entry"} ${e.date}: ${e.description}`,
      needs: [...new Set([...lines.map(({ l }) => akey(l.accountId)), ...contactKeys.filter(Boolean)])], postings: postingsOf(lines.map(({ l }) => l)),
      build: (id) => ({
        TxnDate: e.date, PrivateNote: e.id === OPENING_ENTRY_ID ? `Opening balances at ${e.date}, from Wave` : note({ id: legs.map((x) => x.id).join(", "), description: e.description }),
        Line: lines.map(({ l }, i) => ({
          DetailType: "JournalEntryLineDetail", Amount: n(l.debit > 0n ? l.debit - l.credit : l.credit - l.debit),
          ...(l.description || e.description ? { Description: (l.description || e.description).slice(0, 4000) } : {}),
          JournalEntryLineDetail: {
            PostingType: l.debit > l.credit ? "Debit" : "Credit", AccountRef: ref(id, l.accountId),
            ...(contactKeys[i] ? { Entity: { Type: role(l) === "receivable" ? "Customer" : "Vendor", EntityRef: { value: id(contactKeys[i]!) } } } : {}),
          },
        })),
      }),
    };
  }

  // ---- contacts and items the transactions need -------------------------------
  for (const op of ops) for (const k of op.needs) if (k.startsWith("contact:")) neededContacts.add(k);
  for (const c of books.contacts) if (neededContacts.has(ckey(c.id))) contactOp(ckey(c.id), c.role, c.name, c);
  if (neededContacts.has(PLACEHOLDER_CUSTOMER)) contactOp(PLACEHOLDER_CUSTOMER, "customer", "Unnamed customer (from Wave)");
  if (neededContacts.has(PLACEHOLDER_VENDOR)) contactOp(PLACEHOLDER_VENDOR, "vendor", "Unnamed vendor (from Wave)");
  for (const [key, accountId] of items) {
    const a = accountId === "opening" ? acc.get("wave-exit:opening-balance-equity") : acc.get(accountId);
    const base = accountId === "opening" ? "Opening balance (from Wave)" : `${a?.name ?? "Sales"} (from Wave)`;
    const incomeAccount = accountId === "opening" ? "wave-exit:opening-balance-equity" : accountId;
    if (accountId === "opening" && !used.has(incomeAccount)) addAccountOp(incomeAccount);
    // Reuse an active item of the same name only if it posts to the same (existing) account.
    const mappedTo = existing.get(akey(incomeAccount));
    const same = company.items.find((i) => i.Active !== false && i.Name.toLowerCase() === qboName(base).toLowerCase() && mappedTo && i.IncomeAccountRef?.value === mappedTo);
    if (same) {
      existing.set(key, same.Id);
      continue;
    }
    let name = qboName(base);
    for (let k = 2; itemNames.has(name.toLowerCase()); k++) name = qboName(`${base.replace(/ \(from Wave\)$/, "")} (from Wave ${k})`);
    itemNames.add(name.toLowerCase());
    ops.push({
      key, entity: "Item", phase: 2, label: `Product/service “${name}”`, date: "", waveRefs: [], needs: [akey(incomeAccount)], postings: [],
      build: (id) => ({ Name: name, Type: "Service", IncomeAccountRef: ref(id, incomeAccount) }),
    });
  }
  // Open bills in opening-balances scope post to Opening Balance Equity too.
  if (ops.some((o) => o.needs.includes(akey("wave-exit:opening-balance-equity"))) && !used.has("wave-exit:opening-balance-equity")) addAccountOp("wave-exit:opening-balance-equity");

  function addAccountOp(accountId: string) {
    if (ops.some((o) => o.key === akey(accountId)) || existing.has(akey(accountId))) return;
    const a = acc.get(accountId) ?? syntheticObe();
    const m = defaultMapping([a], company.accounts);
    const c = m.choices.get(a.id)!;
    mapping.choices.set(a.id, c);
    mapping.reasons.set(a.id, m.reasons.get(a.id)!);
    if (c.kind === "existing") existing.set(akey(a.id), c.qboId);
    else ops.push({ key: akey(a.id), entity: "Account", phase: 0, label: `Account “${c.name}”`, date: "", waveRefs: [], needs: [], postings: [], build: () => ({ Name: c.name, AccountType: c.type.AccountType, AccountSubType: c.type.AccountSubType }) });
  }

  function syntheticObe(): Account {
    return {
      id: "wave-exit:opening-balance-equity", code: "", name: "Opening Balance Equity", group: "Equity", type: "EQUITY", subtype: "NON_RETAINED_EARNINGS",
      subtypeName: "", normalBalance: "CREDIT", role: "equity", displayId: "", description: "", currency: "", isArchived: false, isSystem: false, waveIds: [], lineCount: 0,
    };
  }

  // Stable order: phase, then date, then key.
  ops.sort((a, b) => a.phase - b.phase || a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
  return { ops, mapping, existing, skipped, scope: scoped.scope };
}

export interface PlanPreview {
  counts: { entity: QboEntity; count: number }[];
  /** Per account: what the plan posts and what the ledger says it should. */
  accounts: { accountId: string; name: string; target: string; planned: Minor; ledger: Minor }[];
  /** Accounts where the plan and the ledger disagree: should be none. */
  differences: { accountId: string; name: string; planned: Minor; ledger: Minor }[];
  skipped: LoadPlan["skipped"];
}

export function previewPlan(books: Books, plan: LoadPlan, company: ExistingCompany): PlanPreview {
  const counts = new Map<QboEntity, number>();
  for (const op of plan.ops) counts.set(op.entity, (counts.get(op.entity) ?? 0) + 1);
  const planned = new Map<string, Minor>();
  for (const op of plan.ops) for (const [a, v] of op.postings) planned.set(a, (planned.get(a) ?? 0n) + v);
  const scoped = scopedLedger(books);
  const all = [...books.accounts, ...scoped.extraAccounts];
  const ledger = new Map(trialBalance(scoped.entries.filter((e) => e.debitTotal !== 0n), all).map((r) => [r.accountId, r.debit - r.credit] as const));
  // Opening-balances scope: open invoices and bills are carried individually (against
  // Opening Balance Equity), so they belong in the expected figures too.
  if (plan.scope === "opening-balances") {
    for (const op of plan.ops) if (op.key.startsWith("doc:") && !op.waveRefs.length) for (const [a, v] of op.postings) ledger.set(a, (ledger.get(a) ?? 0n) + v);
  }
  const names = new Map(all.map((a) => [a.id, a.name] as const));
  const qboNames = new Map(company.accounts.map((a) => [a.Id, a.Name] as const));
  const ids = [...new Set([...planned.keys(), ...[...ledger].filter(([, v]) => v !== 0n).map(([k]) => k)])];
  const accounts = ids.map((id) => {
    const c = plan.mapping.choices.get(id);
    return {
      accountId: id, name: names.get(id) ?? id,
      target: !c ? "" : c.kind === "existing" ? `${qboNames.get(c.qboId) ?? c.qboId} (already in QuickBooks)` : `${c.name} (new)`,
      planned: planned.get(id) ?? 0n, ledger: ledger.get(id) ?? 0n,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return {
    counts: [...counts].map(([entity, count]) => ({ entity, count })).sort((a, b) => b.count - a.count),
    accounts,
    differences: accounts.filter((a) => a.planned !== a.ledger).map(({ accountId, name, planned, ledger }) => ({ accountId, name, planned, ledger })),
    skipped: plan.skipped,
  };
}
