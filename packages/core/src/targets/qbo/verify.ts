import { formatDisplay, parseAmount, sum, type Minor } from "../../money.ts";
import { agingAt } from "../../model/open-items.ts";
import type { Books, CheckResult } from "../../model/types.ts";
import type { QboClient, QboReport, QboReportRow } from "./client.ts";
import type { LoadRecord } from "./load.ts";
import type { LoadPlan } from "./plan.ts";

/**
 * Tie-out check 8: after a direct load, read QuickBooks's own trial balance and
 * AR/AP aging (reports are a few reads, not one per record) and compare them with
 * what the plan put there, account by account. Differences are listed with the
 * account; anything that was already in the company before the load shows up here.
 *
 * QuickBooks closes profit from earlier fiscal years into Retained Earnings on its
 * trial balance, so income and expense accounts are compared in total with retained
 * earnings rather than one by one.
 */
export async function verifyLoad(books: Books, plan: LoadPlan, record: LoadRecord, client: QboClient): Promise<CheckResult> {
  const exp = books.business.exponent;
  const fmt = (v: Minor) => formatDisplay(v, exp);
  const end = books.period.lastDate;
  const start = plan.scope === "opening-balances" ? books.period.cutoverDate : books.period.firstDate;

  // What the plan posted, by QuickBooks account ID.
  const qboIdOf = new Map<string, string>(plan.existing);
  for (const c of record.created) qboIdOf.set(c.key, c.id);
  const expected = new Map<string, Minor>();
  const kindOf = new Map<string, "bs" | "pl">();
  const nameOf = new Map<string, string>();
  const accounts = new Map(books.accounts.map((a) => [a.id, a] as const));
  for (const op of plan.ops) {
    for (const [accountId, v] of op.postings) {
      const q = qboIdOf.get(`account:${accountId}`);
      if (!q) continue;
      expected.set(q, (expected.get(q) ?? 0n) + v);
      const a = accounts.get(accountId);
      kindOf.set(q, a && (a.type === "INCOME" || a.type === "EXPENSE") ? "pl" : "bs");
      if (a) nameOf.set(q, a.name);
    }
  }

  const tb = await client.report("TrialBalance", { start_date: start, end_date: end, accounting_method: "Accrual" });
  const actual = new Map<string, Minor>();
  for (const row of flatten(tb)) {
    const cols = row.ColData ?? [];
    const id = cols[0]?.id;
    if (!id) continue;
    nameOf.set(id, nameOf.get(id) ?? cols[0]?.value ?? id);
    actual.set(id, num(cols[1]?.value, exp) - num(cols[2]?.value, exp));
  }

  const details: string[] = [];
  let plDiff = 0n;
  for (const id of new Set([...expected.keys(), ...actual.keys()])) {
    const e = expected.get(id) ?? 0n;
    const a = actual.get(id) ?? 0n;
    if (e === a) continue;
    if (kindOf.get(id) === "pl" || (!kindOf.has(id) && /retained earnings/i.test(nameOf.get(id) ?? ""))) {
      plDiff += a - e;
      continue;
    }
    details.push(`${nameOf.get(id) ?? id}: QuickBooks ${fmt(a)}, expected ${fmt(e)} (difference ${fmt(a - e)})`);
  }
  if (plDiff !== 0n) details.push(`Income, expenses and retained earnings together differ by ${fmt(plDiff)}.`);

  // Aging totals at the last ledger date.
  for (const [report, docs, label] of [["AgedReceivables", books.invoices, "Accounts receivable"], ["AgedPayables", books.bills, "Accounts payable"]] as const) {
    if (!docs.length) continue;
    const want = sum(agingAt(docs, end).map((r) => r.amountDue));
    const rep = await client.report(report, { report_date: end, aging_method: "Report_Date" });
    const got = grandTotal(rep, exp);
    if (got !== want) details.push(`${label} aging at ${end}: QuickBooks ${fmt(got)}, expected ${fmt(want)}.`);
  }

  return {
    id: 8,
    title: "QuickBooks matches the books",
    status: details.length ? "red" : "green",
    summary: details.length
      ? `${details.length} ${details.length === 1 ? "difference" : "differences"} between QuickBooks and the converted books. Anything already in the company before the load also shows here.`
      : `QuickBooks's trial balance and aging at ${end} match the converted books.`,
    details,
  };
}

function flatten(r: QboReport): QboReportRow[] {
  const out: QboReportRow[] = [];
  const walk = (rows?: QboReportRow[]) => {
    for (const row of rows ?? []) {
      if (row.ColData) out.push(row);
      walk(row.Rows?.Row);
    }
  };
  walk(r.Rows?.Row);
  return out;
}

function grandTotal(r: QboReport, exp: number): Minor {
  for (const row of r.Rows?.Row ?? []) {
    if (row.group === "GrandTotal" && row.Summary?.ColData) return num(row.Summary.ColData.at(-1)?.value, exp);
  }
  return 0n;
}

function num(v: string | undefined, exp: number): Minor {
  const t = (v ?? "").trim();
  if (!t) return 0n;
  // Reports can print more decimals than the currency ("12.5", "0.4400"); round to the currency.
  const [i, f = ""] = t.replace(/,/g, "").split(".");
  return parseAmount(exp ? `${i}.${f.padEnd(exp, "0").slice(0, exp)}` : i!, exp);
}
