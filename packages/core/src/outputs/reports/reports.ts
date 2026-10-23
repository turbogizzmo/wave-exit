import { formatDisplay, sum, type Minor } from "../../money.ts";
import { trialBalance } from "../../model/ledger.ts";
import type { Books, CheckResult } from "../../model/types.ts";
import type { ReportDocument, ReportRow, ReportSection } from "./document.ts";
import { balanceSheet, fiscalYears, profitAndLoss, type StatementLine } from "./statements.ts";

/**
 * The reports an accountant puts in the client file: the tie-out report (evidence
 * the conversion is complete) and the report pack (trial balance, P&L and balance
 * sheet by year, AR/AP aging, general ledger).
 */

const STATUS_WORD: Record<CheckResult["status"], string> = { green: "OK", amber: "Review", red: "Problem", skipped: "Skipped" };

function money(books: Books) {
  return (v: Minor) => formatDisplay(v, books.business.exponent);
}

function modeLine(books: Books): string {
  return books.mode === "connected"
    ? `Built from Wave's transactions export and a Wave connection (read ${books.waveFetchedAt?.slice(0, 10) ?? "?"}).`
    : "Built from Wave's export files only, without a Wave connection: balances could not be compared with Wave.";
}

export function tieOutReport(books: Books, createdAt: Date): ReportDocument {
  const open = books.issues.filter((i) => !i.resolution);
  const red = books.checks.filter((c) => c.status === "red").length + open.filter((i) => i.severity === "red").length;
  const amber = books.checks.filter((c) => c.status === "amber").length;
  const headline = red
    ? `${red} ${red === 1 ? "item needs" : "items need"} attention before these books can be relied on.`
    : amber
      ? `Every check passed or is explained: ${amber} ${amber === 1 ? "check has" : "checks have"} notes to review.`
      : "Every check passed.";
  const summary: ReportSection = {
    title: "Summary",
    paragraphs: [
      headline,
      `Period: ${books.period.firstDate} to ${books.period.lastDate}. Cutover date: ${books.period.cutoverDate}. Scope: ${books.settings.scope === "opening-balances" ? "opening balances at the cutover date" : "full history"}.`,
      modeLine(books),
      `${books.entries.length} entries, ${books.entries.reduce((n, e) => n + e.lines.length, 0)} lines, ${books.accounts.length} accounts, ${books.contacts.length} contacts, ${books.invoices.length} invoices, ${books.bills.length} ${books.bills.length === 1 ? "bill" : "bills"}, ${books.receipts.length} receipts.`,
    ],
    table: {
      columns: [{ title: "Check", align: "left", width: 0.34 }, { title: "Result", align: "left", width: 0.1 }, { title: "Finding", align: "left", width: 0.56 }],
      rows: books.checks.map((c) => ({ cells: [`${c.id}. ${c.title}`, STATUS_WORD[c.status], c.summary], style: c.status === "red" ? "bold" : "normal" })),
    },
  };

  const sources: ReportSection = {
    title: "Source files",
    paragraphs: [books.exportedAt ? `Wave wrote the export on ${books.exportedAt.slice(0, 10)}.` : "The export's creation time isn't recorded in the file."],
    table: {
      columns: [{ title: "File", align: "left", width: 0.2 }, { title: "Rows", align: "right", width: 0.08 }, { title: "SHA-256", align: "left", width: 0.72 }],
      rows: books.sources.map((s) => ({ cells: [s.name, String(s.rows), s.sha256] })),
    },
  };

  const details: ReportSection[] = books.checks.map((c, i) => ({
    title: `Check ${c.id}: ${c.title}`,
    subtitle: `${STATUS_WORD[c.status]}. ${c.summary}`,
    paragraphs: c.details.length ? c.details : ["No further detail."],
    ...(i === 0 ? { newPage: true } : {}),
  }));

  const review: ReportSection = {
    title: "Review items",
    newPage: true,
    paragraphs: books.issues.length ? [] : ["Nothing needed a person's attention."],
    ...(books.issues.length
      ? {
          table: {
            columns: [{ title: "Item", align: "left", width: 0.32 }, { title: "Level", align: "left", width: 0.08 }, { title: "Answer", align: "left", width: 0.6 }],
            rows: books.issues.map((i) => ({
              cells: [i.title, i.severity, i.resolution ? (i.options.find((o) => o.value === i.resolution)?.label ?? i.resolution) : "Not answered"],
            })),
          },
        }
      : {}),
  };

  return {
    title: "Tie-out report",
    business: books.business.name,
    subtitle: `Wave Exit conversion checks, made ${createdAt.toISOString().slice(0, 10)}`,
    sections: [summary, sources, ...details, review],
  };
}

export function reportPack(books: Books, createdAt: Date): ReportDocument {
  const m = money(books);
  const acc = new Map(books.accounts.map((a) => [a.id, a] as const));
  const con = new Map(books.contacts.map((c) => [c.id, c] as const));
  const sections: ReportSection[] = [];

  // Trial balance(s).
  for (const asOf of [...new Set([books.period.cutoverDate, books.period.lastDate])].sort()) {
    const tb = trialBalance(books.entries, books.accounts, asOf).filter((r) => r.debit !== 0n || r.credit !== 0n);
    const rows: ReportRow[] = tb
      .map((r) => ({ r, a: acc.get(r.accountId)! }))
      .sort((x, y) => x.a.code.localeCompare(y.a.code, undefined, { numeric: true }))
      .map(({ r, a }) => {
        const net = r.debit - r.credit;
        return { cells: [a.code, a.name + (a.isArchived ? " (archived)" : ""), net > 0n ? m(net) : "", net < 0n ? m(-net) : ""] };
      });
    const dr = sum(tb.map((r) => (r.debit > r.credit ? r.debit - r.credit : 0n)));
    const cr = sum(tb.map((r) => (r.credit > r.debit ? r.credit - r.debit : 0n)));
    rows.push({ cells: ["", "Total", m(dr), m(cr)], style: "total" });
    sections.push({
      title: `Trial balance at ${asOf}`, newPage: sections.length > 0,
      table: { columns: [{ title: "Code", align: "left", width: 0.1 }, { title: "Account", align: "left", width: 0.5 }, { title: "Debit", align: "right", width: 0.2 }, { title: "Credit", align: "right", width: 0.2 }], rows },
    });
  }

  // P&L and balance sheet for each fiscal year.
  const lines = (ls: StatementLine[], indent = 1): ReportRow[] => ls.map((l) => ({ cells: [`${l.account.code}  ${l.account.name}`, m(l.amount)], indent }));
  const two = [{ title: "", align: "left" as const, width: 0.7 }, { title: "Amount", align: "right" as const, width: 0.3 }];
  for (const y of fiscalYears(books)) {
    const p = profitAndLoss(books, y);
    const partial = y.start < books.period.firstDate || y.end > books.period.lastDate;
    sections.push({
      title: `Profit and loss: ${y.label}`, subtitle: `${y.start} to ${y.end}${partial ? " (the ledger covers only part of this year)" : ""}`, newPage: true,
      table: {
        columns: two,
        rows: [
          { cells: ["Income"], style: "heading" }, ...lines(p.income), { cells: ["Total income", m(p.totalIncome)], style: "total" },
          ...(p.costOfSales.length ? [{ cells: ["Cost of goods sold"], style: "heading" as const }, ...lines(p.costOfSales), { cells: ["Total cost of goods sold", m(p.totalCostOfSales)], style: "total" as const }, { cells: ["Gross profit", m(p.grossProfit)], style: "total" as const }] : []),
          { cells: ["Expenses"], style: "heading" }, ...lines(p.expenses), { cells: ["Total expenses", m(p.totalExpenses)], style: "total" },
          { cells: ["Net income", m(p.netIncome)], style: "total" },
        ],
      },
    });
    const asOf = y.end < books.period.lastDate ? y.end : books.period.lastDate;
    const b = balanceSheet(books, asOf);
    sections.push({
      title: `Balance sheet at ${asOf}`, newPage: true,
      paragraphs: b.totalAssets === b.totalLiabilities + b.totalEquity ? [] : ["The balance sheet does not balance. See the tie-out report."],
      table: {
        columns: two,
        rows: [
          { cells: ["Assets"], style: "heading" }, ...lines(b.assets), { cells: ["Total assets", m(b.totalAssets)], style: "total" },
          { cells: ["Liabilities"], style: "heading" }, ...lines(b.liabilities), { cells: ["Total liabilities", m(b.totalLiabilities)], style: "total" },
          { cells: ["Equity"], style: "heading" }, ...lines(b.equity),
          { cells: ["Retained earnings (profit from earlier years)", m(b.retainedEarnings)], indent: 1 },
          { cells: ["Net income this year", m(b.currentYearEarnings)], indent: 1 },
          { cells: ["Total equity", m(b.totalEquity)], style: "total" },
          { cells: ["Total liabilities and equity", m(b.totalLiabilities + b.totalEquity)], style: "total" },
        ],
      },
    });
  }

  // Aging.
  for (const [rows, label, who] of [[books.agingAr, "Accounts receivable aging", "Customer"], [books.agingAp, "Accounts payable aging", "Vendor"]] as const) {
    const buckets = ["current", "1-30", "31-60", "61-90", "90+"] as const;
    const byContact = new Map<string, Minor[]>();
    for (const r of rows) {
      const v = byContact.get(r.contactId) ?? buckets.map(() => 0n);
      v[buckets.indexOf(r.bucket)]! += r.amountDue;
      byContact.set(r.contactId, v);
    }
    const totals = buckets.map((_, i) => sum([...byContact.values()].map((v) => v[i]!)));
    const unknownDue = rows.some((r) => !r.dueDateKnown);
    sections.push({
      title: `${label} at ${books.period.cutoverDate}`, newPage: true,
      paragraphs: [
        rows.length ? `${rows.length} open ${rows.length === 1 ? "document" : "documents"}, totalling ${m(sum(totals))}.` : "Nothing open.",
        ...(unknownDue ? ["Due dates aren't in Wave's export, so without a Wave connection documents are aged from their own date."] : []),
      ],
      table: {
        columns: [{ title: who, align: "left", width: 0.3 }, ...buckets.map((b) => ({ title: b === "current" ? "Current" : b, align: "right" as const, width: 0.14 }))],
        rows: [
          ...[...byContact.entries()].sort((a, b) => (con.get(a[0])?.name ?? "").localeCompare(con.get(b[0])?.name ?? "")).map(([id, v]) => ({ cells: [con.get(id)?.name ?? "(no name)", ...v.map((x) => (x ? m(x) : ""))] })),
          { cells: ["Total", ...totals.map((x) => m(x))], style: "total" as const },
        ],
      },
    });
    if (rows.length) {
      sections.push({
        title: `${label}: detail`,
        table: {
          columns: [{ title: "Number", align: "left", width: 0.12 }, { title: who, align: "left", width: 0.3 }, { title: "Date", align: "left", width: 0.13 }, { title: "Due", align: "left", width: 0.13 }, { title: "Days", align: "right", width: 0.08 }, { title: "Owed", align: "right", width: 0.24 }],
          rows: rows.map((r) => ({ cells: [r.number, con.get(r.contactId)?.name ?? "", r.date, r.dueDate, String(r.daysPastDue), m(r.amountDue)] })),
        },
      });
    }
  }

  // General ledger.
  const byAccount = new Map<string, { date: string; entry: string; text: string; contact: string; debit: Minor; credit: Minor }[]>();
  for (const e of books.entries) {
    for (const l of e.lines) {
      const list = byAccount.get(l.accountId) ?? [];
      list.push({ date: e.date, entry: e.id, text: l.description ? `${e.description}: ${l.description}` : e.description, contact: con.get(l.customerId)?.name ?? con.get(l.vendorId)?.name ?? con.get(e.customerId)?.name ?? con.get(e.vendorId)?.name ?? "", debit: l.debit, credit: l.credit });
      byAccount.set(l.accountId, list);
    }
  }
  const glAccounts = books.accounts.filter((a) => byAccount.has(a.id)).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  glAccounts.forEach((a, i) => {
    let bal = 0n;
    const sign = a.normalBalance === "DEBIT" ? 1n : -1n;
    const rows: ReportRow[] = byAccount.get(a.id)!.map((x) => {
      bal += sign * (x.debit - x.credit);
      return { cells: [x.date, x.text, x.contact, x.debit ? m(x.debit) : "", x.credit ? m(x.credit) : "", m(bal)] };
    });
    rows.push({ cells: ["", "Balance", "", "", "", m(bal)], style: "total" });
    sections.push({
      title: `General ledger: ${a.code} ${a.name}`, ...(i === 0 ? { newPage: true } : {}),
      table: {
        columns: [{ title: "Date", align: "left", width: 0.12 }, { title: "Description", align: "left", width: 0.34 }, { title: "Contact", align: "left", width: 0.16 }, { title: "Debit", align: "right", width: 0.12 }, { title: "Credit", align: "right", width: 0.12 }, { title: "Balance", align: "right", width: 0.14 }],
        rows,
      },
    });
  });

  const tie = tieOutReport(books, createdAt);
  return {
    title: "Report pack",
    business: books.business.name,
    subtitle: `${books.period.firstDate} to ${books.period.lastDate}, made ${createdAt.toISOString().slice(0, 10)} by Wave Exit. Amounts in ${books.business.currency || "the business currency"}; negatives in parentheses.`,
    sections: [...tie.sections.map((s, i) => ({ ...s, title: i === 0 ? "Tie-out summary" : s.title })), ...sections.map((s, i) => (i === 0 ? { ...s, newPage: true } : s))],
  };
}
