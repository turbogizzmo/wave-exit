import type { Fetch } from "../../src/readers/wave-api/client.ts";

/**
 * An in-memory QuickBooks Online company for tests. It enforces the rules from
 * Intuit's reference pages that the load depends on (asset-only transfers, card-only
 * purchase credits, item-based sales lines, A/R journal lines need a customer,
 * unique names, linked transactions exist, Id + SyncToken to delete), replays a
 * repeated `requestid` the way Intuit documents, keeps postings so its TrialBalance
 * and aging reports reflect what was loaded, and can simulate the app dying after
 * QuickBooks has applied a batch but before the answer arrives.
 */

type Obj = Record<string, any> & { Id: string; SyncToken: string };

export interface FakeQboOptions {
  /** Throw a network error after applying this many batches (the server did the work; the client never heard). */
  dieAfterBatches?: number;
  /** Extra accounts the company starts with. */
  accounts?: Partial<Obj>[];
}

export interface FakeQbo {
  fetch: Fetch;
  store: Map<string, Map<string, Obj>>;
  requests: { method: string; path: string; requestId: string | null }[];
  /** Created objects by type, excluding the company's starting accounts. */
  count(entity: string, onlyActive?: boolean): number;
  options: FakeQboOptions;
}

const CLASS: Record<string, string> = {
  Bank: "Asset", "Accounts Receivable": "Asset", "Other Current Asset": "Asset", "Fixed Asset": "Asset", "Other Asset": "Asset",
  "Accounts Payable": "Liability", "Credit Card": "Liability", "Other Current Liability": "Liability", "Long Term Liability": "Liability",
  Equity: "Equity", Income: "Revenue", "Other Income": "Revenue", "Cost of Goods Sold": "Expense", Expense: "Expense", "Other Expense": "Expense",
};

export function fakeQbo(options: FakeQboOptions = {}): FakeQbo {
  let nextId = 100;
  const store = new Map<string, Map<string, Obj>>();
  const starting = new Set<string>();
  const replay = new Map<string, unknown>();
  const requests: FakeQbo["requests"] = [];
  let batches = 0;
  const table = (e: string) => {
    if (!store.has(e)) store.set(e, new Map());
    return store.get(e)!;
  };
  const put = (e: string, o: Record<string, any>, isStarting = false) => {
    const obj = { ...o, Id: String(nextId++), SyncToken: "0" } as Obj;
    if (e === "Account") obj.Classification = CLASS[obj.AccountType];
    if (obj.Active === undefined && ["Account", "Customer", "Vendor", "Item"].includes(e)) obj.Active = true;
    table(e).set(obj.Id, obj);
    if (isStarting) starting.add(`${e}:${obj.Id}`);
    return obj;
  };
  for (const a of [
    { Name: "Accounts Receivable (A/R)", AccountType: "Accounts Receivable", AccountSubType: "AccountsReceivable" },
    { Name: "Accounts Payable (A/P)", AccountType: "Accounts Payable", AccountSubType: "AccountsPayable" },
    { Name: "Retained Earnings", AccountType: "Equity", AccountSubType: "RetainedEarnings" },
    { Name: "Opening Balance Equity", AccountType: "Equity", AccountSubType: "OpeningBalanceEquity" },
    ...(options.accounts ?? []),
  ]) put("Account", a, true);

  const acct = (ref: any) => {
    const a = table("Account").get(String(ref?.value));
    if (!a) throw fault("Invalid Reference Id", `Account ${ref?.value} not found`);
    return a;
  };
  const exists = (e: string, ref: any) => {
    if (!table(e).has(String(ref?.value))) throw fault("Invalid Reference Id", `${e} ${ref?.value} not found`);
  };
  const money = (v: any) => Math.round(Number(v) * 100);

  function validate(e: string, o: Record<string, any>) {
    const nameDup = (field: string, kinds: string[]) => {
      const v = String(o[field] ?? "").toLowerCase();
      for (const k of kinds) for (const x of table(k).values()) if (String(x[field] ?? x.DisplayName ?? x.Name).toLowerCase() === v) throw fault("Duplicate Name Exists Error", `The name supplied already exists. : ${o[field]}`);
    };
    switch (e) {
      case "Account":
        if (!o.Name || /[":]/.test(o.Name) || o.Name.length > 100) throw fault("Invalid Name", o.Name);
        if (!CLASS[o.AccountType]) throw fault("Invalid AccountType", o.AccountType);
        nameDup("Name", ["Account"]);
        break;
      case "Customer": case "Vendor":
        nameDup("DisplayName", ["Customer", "Vendor"]);
        break;
      case "Item":
        nameDup("Name", ["Item"]);
        acct(o.IncomeAccountRef);
        break;
      case "Purchase":
        acct(o.AccountRef);
        if (o.Credit && o.PaymentType !== "CreditCard") throw fault("Invalid Credit", "Credit valid only for CreditCard");
        for (const l of o.Line) acct(l.AccountBasedExpenseLineDetail.AccountRef);
        break;
      case "Deposit":
        acct(o.DepositToAccountRef);
        for (const l of o.Line) acct(l.DepositLineDetail.AccountRef);
        break;
      case "Transfer":
        if (acct(o.FromAccountRef).Classification !== "Asset" || acct(o.ToAccountRef).Classification !== "Asset") throw fault("Invalid account", "Transfer accounts must be Asset");
        break;
      case "CreditCardPayment":
        if (acct(o.BankAccountRef).AccountType !== "Bank" || acct(o.CreditCardAccountRef).AccountType !== "Credit Card") throw fault("Invalid account", "bank → card only");
        break;
      case "Invoice": case "SalesReceipt":
        if (e === "Invoice") exists("Customer", o.CustomerRef);
        for (const l of o.Line) {
          if (l.DetailType !== "SalesItemLineDetail" || !l.SalesItemLineDetail?.ItemRef) throw fault("Item required", "SalesItemLine needs ItemRef");
          exists("Item", l.SalesItemLineDetail.ItemRef);
        }
        if (e === "Invoice" && (o.AllowOnlineCreditCardPayment !== false || o.AllowOnlineACHPayment !== false)) throw new Error("test guard: invoice could be auto-emailed to the customer");
        break;
      case "Bill":
        exists("Vendor", o.VendorRef);
        for (const l of o.Line) acct(l.AccountBasedExpenseLineDetail.AccountRef);
        break;
      case "Payment": case "BillPayment": {
        exists(e === "Payment" ? "Customer" : "Vendor", e === "Payment" ? o.CustomerRef : o.VendorRef);
        let applied = 0;
        for (const l of o.Line) {
          for (const t of l.LinkedTxn) exists(t.TxnType, { value: t.TxnId });
          applied += money(l.Amount);
        }
        if (applied !== money(o.TotalAmt)) throw fault("Amount mismatch", "lines must add up to TotalAmt here");
        break;
      }
      case "JournalEntry": {
        let dr = 0, cr = 0;
        for (const l of o.Line) {
          const d = l.JournalEntryLineDetail;
          const a = acct(d.AccountRef);
          if (a.AccountType === "Accounts Receivable" && d.Entity?.Type !== "Customer") throw fault("Customer required", "A/R line needs a customer");
          if (a.AccountType === "Accounts Payable" && d.Entity?.Type !== "Vendor") throw fault("Vendor required", "A/P line needs a vendor");
          if (d.PostingType === "Debit") dr += money(l.Amount);
          else cr += money(l.Amount);
        }
        if (dr !== cr || !dr) throw fault("Unbalanced", "debits must equal credits");
        break;
      }
    }
  }

  function apply(item: any): any {
    const entity = Object.keys(item).find((k) => !["bId", "operation"].includes(k))!;
    const body = item[entity];
    try {
      if (item.operation === "create") {
        validate(entity, body);
        return { bId: item.bId, [entity]: put(entity, body) };
      }
      const cur = table(entity).get(String(body.Id));
      if (!cur) throw fault("Object Not Found", `${entity} ${body.Id}`);
      if (String(body.SyncToken) !== cur.SyncToken) throw fault("Stale Object Error", "You and someone else edited this transaction");
      if (item.operation === "delete") {
        table(entity).delete(cur.Id);
        return { bId: item.bId, [entity]: { Id: cur.Id, status: "Deleted" } };
      }
      Object.assign(cur, body, { SyncToken: String(Number(cur.SyncToken) + 1) });
      return { bId: item.bId, [entity]: cur };
    } catch (e: any) {
      if (e?.Fault) return { bId: item.bId, Fault: e.Fault };
      throw e;
    }
  }

  function postings(): Map<string, number> {
    const m = new Map<string, number>();
    const add = (id: string, v: number) => m.set(id, (m.get(id) ?? 0) + v);
    const ar = [...table("Account").values()].find((a) => a.AccountType === "Accounts Receivable")!.Id;
    const ap = [...table("Account").values()].find((a) => a.AccountType === "Accounts Payable")!.Id;
    const itemAcct = (ref: any) => table("Item").get(String(ref.value))!.IncomeAccountRef.value;
    for (const p of table("Purchase").values()) {
      const sign = p.Credit ? -1 : 1;
      for (const l of p.Line) add(l.AccountBasedExpenseLineDetail.AccountRef.value, sign * money(l.Amount));
      add(p.AccountRef.value, -sign * p.Line.reduce((s: number, l: any) => s + money(l.Amount), 0));
    }
    for (const d of table("Deposit").values()) {
      for (const l of d.Line) add(l.DepositLineDetail.AccountRef.value, -money(l.Amount));
      add(d.DepositToAccountRef.value, d.Line.reduce((s: number, l: any) => s + money(l.Amount), 0));
    }
    for (const r of table("SalesReceipt").values()) {
      for (const l of r.Line) add(itemAcct(l.SalesItemLineDetail.ItemRef), -money(l.Amount));
      add(r.DepositToAccountRef.value, r.Line.reduce((s: number, l: any) => s + money(l.Amount), 0));
    }
    for (const t of table("Transfer").values()) { add(t.ToAccountRef.value, money(t.Amount)); add(t.FromAccountRef.value, -money(t.Amount)); }
    for (const t of table("CreditCardPayment").values()) { add(t.CreditCardAccountRef.value, money(t.Amount)); add(t.BankAccountRef.value, -money(t.Amount)); }
    for (const i of table("Invoice").values()) {
      for (const l of i.Line) add(itemAcct(l.SalesItemLineDetail.ItemRef), -money(l.Amount));
      add(i.ARAccountRef?.value ?? ar, i.Line.reduce((s: number, l: any) => s + money(l.Amount), 0));
    }
    for (const b of table("Bill").values()) {
      for (const l of b.Line) add(l.AccountBasedExpenseLineDetail.AccountRef.value, money(l.Amount));
      add(b.APAccountRef?.value ?? ap, -b.Line.reduce((s: number, l: any) => s + money(l.Amount), 0));
    }
    for (const p of table("Payment").values()) {
      add(p.DepositToAccountRef.value, money(p.TotalAmt));
      const inv = table("Invoice").get(p.Line[0].LinkedTxn[0].TxnId)!;
      add(inv.ARAccountRef?.value ?? ar, -money(p.TotalAmt));
    }
    for (const p of table("BillPayment").values()) {
      add((p.CheckPayment?.BankAccountRef ?? p.CreditCardPayment.CCAccountRef).value, -money(p.TotalAmt));
      const bill = table("Bill").get(p.Line[0].LinkedTxn[0].TxnId)!;
      add(bill.APAccountRef?.value ?? ap, money(p.TotalAmt));
    }
    for (const j of table("JournalEntry").values()) for (const l of j.Line) add(l.JournalEntryLineDetail.AccountRef.value, (l.JournalEntryLineDetail.PostingType === "Debit" ? 1 : -1) * money(l.Amount));
    return m;
  }

  function openBalance(kind: "Invoice" | "Bill"): number {
    let total = 0;
    for (const d of table(kind).values()) {
      const amount = d.Line.reduce((s: number, l: any) => s + money(l.Amount), 0);
      let paid = 0;
      for (const p of table(kind === "Invoice" ? "Payment" : "BillPayment").values()) for (const l of p.Line) for (const t of l.LinkedTxn) if (t.TxnId === d.Id) paid += money(l.Amount);
      total += amount - paid;
    }
    return total;
  }

  const fmt = (c: number) => (c / 100).toFixed(2);

  const fetch: Fetch = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v3\/company\/[^/]+/, "");
    const requestId = u.searchParams.get("requestid");
    requests.push({ method: init.method, path, requestId });
    const reply = (status: number, body: unknown) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
    if (!init.headers.Authorization?.startsWith("Bearer ")) return reply(401, { Fault: { type: "AUTHENTICATION", Error: [{ Message: "no token" }] } });
    if (u.searchParams.get("minorversion") !== "75") return reply(400, { Fault: { type: "ValidationFault", Error: [{ Message: "minorversion" }] } });
    if (requestId && replay.has(requestId)) return reply(200, replay.get(requestId));

    if (init.method === "GET" && path === "/query") {
      const m = /select \* from (\w+)/i.exec(u.searchParams.get("query") ?? "")!;
      return reply(200, { QueryResponse: { [m[1]!]: [...table(m[1]!).values()] } });
    }
    if (init.method === "GET" && path.startsWith("/reports/")) {
      const name = path.slice("/reports/".length);
      if (name === "TrialBalance") {
        const rows = [...postings()].filter(([, v]) => v !== 0).map(([id, v]) => ({ ColData: [{ id, value: table("Account").get(id)?.Name }, { value: v > 0 ? fmt(v) : "" }, { value: v < 0 ? fmt(-v) : "" }] }));
        return reply(200, { Header: { ReportName: name }, Rows: { Row: rows } });
      }
      if (name === "AgedReceivables" || name === "AgedPayables") {
        const t = openBalance(name === "AgedReceivables" ? "Invoice" : "Bill");
        return reply(200, { Rows: { Row: [{ group: "GrandTotal", type: "Section", Summary: { ColData: [{ value: "TOTAL" }, { value: fmt(t) }] } }] } });
      }
    }
    if (init.method === "POST" && path === "/batch") {
      const body = JSON.parse(init.body) as { BatchItemRequest: any[] };
      if (body.BatchItemRequest.length > 30) return reply(400, { Fault: { type: "ValidationFault", Error: [{ Message: "too many" }] } });
      const resp = { BatchItemResponse: body.BatchItemRequest.map(apply) };
      if (requestId) replay.set(requestId, resp);
      batches++;
      if (options.dieAfterBatches !== undefined && batches === options.dieAfterBatches) {
        options.dieAfterBatches = undefined;
        throw new TypeError("network connection lost (simulated)");
      }
      return reply(200, resp);
    }
    return reply(404, { Fault: { type: "NotFound", Error: [{ Message: `no route ${init.method} ${path}` }] } });
  };

  return {
    fetch, store, requests, options,
    count: (entity, onlyActive = false) => [...table(entity).values()].filter((o) => !starting.has(`${entity}:${o.Id}`) && (!onlyActive || o.Active !== false)).length,
  };
}

function fault(message: string, detail: string) {
  return { Fault: { type: "ValidationFault", Error: [{ Message: message, Detail: detail, code: "6000" }] } };
}
