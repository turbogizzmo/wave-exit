import { formatPlain, sum, type Minor } from "../money.ts";
import type { BusinessMatch } from "./identity.ts";
import { trialBalance } from "./ledger.ts";
import type { Account, CheckResult, Entry, Issue, OpenDocument, ReceiptLink, Severity } from "./types.ts";

/**
 * The tie-out checks (the trust feature). Each says, in one sentence, whether the
 * books hold together, with detail lines for the report. Check 8 (after a direct
 * load) belongs to the direct-load outputs.
 */

export interface CheckInputs {
  mode: "connected" | "export-file-only";
  exponent: number;
  businessCurrency: string;
  accounts: Account[];
  entries: Entry[];
  invoices: OpenDocument[];
  bills: OpenDocument[];
  receipts: ReceiptLink[];
  issues: Issue[];
  rowCounts: { ledgerRows: number; exportCustomers: number; exportVendors: number; receiptFiles: number };
  /** Day the export was made (ZIP time), else when Wave was read, else today. */
  exportDate: string;
  lastModified: string;
  waveInvoiceCount?: number;
  businessMatch?: BusinessMatch;
  resolutions: Record<string, string>;
}

export function runChecks(x: CheckInputs): { checks: CheckResult[]; issues: Issue[] } {
  const fmt = (v: Minor) => formatPlain(v, x.exponent);
  const acc = new Map(x.accounts.map((a) => [a.id, a] as const));
  const name = (id: string) => acc.get(id)?.name ?? id;
  const issues: Issue[] = [];
  const checks: CheckResult[] = [];

  // 1. Every entry balances.
  const unbalanced = x.entries.filter((e) => e.debitTotal !== e.creditTotal);
  checks.push({
    id: 1,
    title: "Every entry balances",
    status: unbalanced.length ? "red" : "green",
    summary: unbalanced.length
      ? `${unbalanced.length} of ${x.entries.length} entries have debits that don't equal their credits.`
      : `All ${x.entries.length} entries have equal debits and credits.`,
    details: unbalanced.slice(0, 100).map((e) => `${e.date} ${e.id} "${e.description}": debits ${fmt(e.debitTotal)}, credits ${fmt(e.creditTotal)}`),
  });
  for (const e of unbalanced) {
    issues.push({
      id: `unbalanced-entry:${e.id}`, kind: "unbalanced-entry", severity: "red",
      title: `Entry on ${e.date} doesn't balance`,
      explanation: `"${e.description}" has debits of ${fmt(e.debitTotal)} and credits of ${fmt(e.creditTotal)}. Wave's exports have always balanced, so the file may have been edited or cut off. Request a fresh export, or accept it and carry the difference for review.`,
      options: [{ value: "accept", label: "Accept and carry it as it is" }], refs: [e.id],
    });
  }

  // 2. The whole ledger balances.
  const dr = sum(x.entries.map((e) => e.debitTotal));
  const cr = sum(x.entries.map((e) => e.creditTotal));
  checks.push({
    id: 2, title: "Total debits equal total credits",
    status: dr === cr ? "green" : "red",
    summary: dr === cr ? `Debits and credits both total ${fmt(dr)}.` : `Debits total ${fmt(dr)} but credits total ${fmt(cr)}.`,
    details: [],
  });

  // 3. Balances agree with Wave.
  if (x.mode === "export-file-only") {
    checks.push({ id: 3, title: "Account balances agree with Wave", status: "skipped", summary: "Skipped: there is no Wave connection to compare with.", details: [] });
  } else {
    const tb = new Map(trialBalance(x.entries, x.accounts).map((r) => [r.accountId, r.balance] as const));
    const diffs: { a: Account; ledger: Minor; wave: Minor }[] = [];
    const skipped: string[] = [];
    let compared = 0;
    for (const a of x.accounts) {
      if (a.waveBalance === undefined) continue;
      if (a.currency && a.currency !== x.businessCurrency) {
        skipped.push(`${a.name}: kept in ${a.currency}, not compared`);
        continue;
      }
      compared++;
      const ledger = tb.get(a.id) ?? 0n;
      if (ledger !== a.waveBalance) diffs.push({ a, ledger, wave: a.waveBalance });
    }
    const accepted = !!x.resolutions["balance-difference"];
    const status: Severity = diffs.length ? (accepted ? "amber" : "red") : "green";
    checks.push({
      id: 3, title: "Account balances agree with Wave", status,
      summary: diffs.length
        ? `${diffs.length} of ${compared} accounts differ from the balance Wave shows today.`
        : `All ${compared} accounts match the balance Wave shows today.`,
      details: [...diffs.map((d) => `${d.a.name}: export ${fmt(d.ledger)}, Wave ${fmt(d.wave)}, difference ${fmt(d.wave - d.ledger)}`), ...skipped],
    });
    if (diffs.length) {
      issues.push({
        id: "balance-difference", kind: "balance-difference", severity: "red",
        title: `${diffs.length} account ${diffs.length === 1 ? "balance differs" : "balances differ"} from Wave`,
        explanation: `Wave's balance today doesn't match the export for ${diffs.map((d) => d.a.name).join(", ")}. The usual cause is transactions added or changed in Wave after the export was made: the newest change in this export is dated ${x.lastModified || "unknown"}. Request a fresh export from Wave, or accept the differences if the books are meant to stop at the export.`,
        options: [{ value: "accept", label: "Accept: convert the books as of the export" }],
        refs: diffs.map((d) => d.a.id),
      });
    }
  }

  // 4. Invoices.
  {
    const details: string[] = [];
    let status: Severity = "green";
    const arAccounts = x.accounts.filter((a) => a.role === "receivable");
    const tb = new Map(trialBalance(x.entries, x.accounts).map((r) => [r.accountId, r.balance] as const));
    const arBalance = sum(arAccounts.map((a) => tb.get(a.id) ?? 0n));
    const openAr = sum(x.invoices.map((d) => d.amountDue));
    if (x.waveInvoiceCount !== undefined) {
      const inLedger = x.invoices.filter((d) => d.entryIds.length).length;
      details.push(`Wave lists ${x.waveInvoiceCount} posted invoices; ${inLedger} were found in the export.`);
      if (inLedger !== x.waveInvoiceCount) status = "amber";
      const waveDue = sum(x.invoices.map((d) => d.wave?.amountDue ?? 0n));
      details.push(`Still owed per Wave: ${fmt(waveDue)}. Still owed per the export's payments: ${fmt(openAr)}.`);
      if (waveDue !== openAr) status = "amber";
    }
    const mismatches = x.issues.filter((i) => i.kind === "invoice-mismatch" || (i.kind === "payment-unlinked" && !i.id.startsWith("payment-unlinked:bill:")));
    if (mismatches.length) status = "amber";
    details.push(...mismatches.map((i) => i.title));
    details.push(`Accounts receivable balance: ${fmt(arBalance)}. Open invoices total: ${fmt(openAr)}.`);
    if (arBalance !== openAr) {
      status = "amber";
      details.push(`Difference ${fmt(arBalance - openAr)}: receivable entries without an invoice number (customer credits, overpayments, write-offs) usually explain it.`);
    }
    checks.push({
      id: 4, title: "Invoices and payments agree",
      status: x.invoices.length || arBalance ? status : "green",
      summary: x.invoices.length
        ? status === "green"
          ? `${x.invoices.length} invoices: every total, payment and amount still owed agrees, and they add up to accounts receivable.`
          : `${x.invoices.length} invoices: some amounts need a look (see detail).`
        : "No invoices in these books.",
      details,
    });
  }

  // 5. Bills.
  {
    const apAccounts = x.accounts.filter((a) => a.role === "payable");
    const tb = new Map(trialBalance(x.entries, x.accounts).map((r) => [r.accountId, r.balance] as const));
    const apBalance = sum(apAccounts.map((a) => tb.get(a.id) ?? 0n));
    const openAp = sum(x.bills.map((d) => d.amountDue));
    const ok = apBalance === openAp;
    checks.push({
      id: 5, title: "Bills add up to accounts payable",
      status: ok ? "green" : "amber",
      summary: x.bills.length
        ? ok ? `${x.bills.length} bills; open bills total ${fmt(openAp)}, equal to accounts payable.` : `Open bills total ${fmt(openAp)} but accounts payable is ${fmt(apBalance)}.`
        : apBalance ? `No bills found, but accounts payable is ${fmt(apBalance)}.` : "No bills in these books.",
      details: x.bills.length ? ["Bill handling hasn't yet been checked against a real Wave export that uses bills. Review bills carefully."] : [],
    });
  }

  // 6. Row counts.
  {
    const lines = sum(x.entries.map((e) => BigInt(e.lines.length)));
    const exportContacts = x.rowCounts.exportCustomers + x.rowCounts.exportVendors;
    const linked = x.receipts.filter((r) => r.status === "linked").length;
    const ok = Number(lines) === x.rowCounts.ledgerRows && x.receipts.length === x.rowCounts.receiptFiles;
    checks.push({
      id: 6, title: "Nothing lost in reading",
      status: ok ? "green" : "red",
      summary: ok
        ? `All ${x.rowCounts.ledgerRows} ledger lines, ${exportContacts} contacts and ${x.rowCounts.receiptFiles} receipts were read.`
        : `Rows went missing while reading: ${x.rowCounts.ledgerRows} ledger lines in, ${lines} kept; ${x.rowCounts.receiptFiles} receipts in, ${x.receipts.length} kept.`,
      details: [
        `accounting.csv: ${x.rowCounts.ledgerRows} lines in, ${lines} lines in ${x.entries.length} entries.`,
        `customers.csv + vendors.csv: ${exportContacts} contacts in.`,
        `Receipts: ${x.rowCounts.receiptFiles} files in, ${linked} linked to transactions, ${x.receipts.length - linked} kept unlinked.`,
      ],
    });
  }

  // 7. Dates.
  {
    const future = x.entries.filter((e) => e.date > x.exportDate);
    const ancient = x.entries.filter((e) => e.date < "1980-01-01");
    checks.push({
      id: 7, title: "Dates are plausible",
      status: future.length || ancient.length ? "amber" : "green",
      summary: future.length || ancient.length
        ? `${future.length} entries are dated after the export (${x.exportDate})${ancient.length ? ` and ${ancient.length} before 1980` : ""}.`
        : `All entries fall between ${x.entries[0]?.date ?? "–"} and ${x.entries.at(-1)?.date ?? "–"}, before the export date ${x.exportDate}.`,
      details: [...future, ...ancient].slice(0, 100).map((e) => `${e.date} ${e.id} "${e.description}"`),
    });
  }

  if (x.businessMatch && x.businessMatch.verdict !== "same-business") {
    const m = x.businessMatch;
    issues.push({
      id: "wrong-business", kind: "wrong-business",
      severity: m.verdict === "different-business" ? "red" : "amber",
      title: m.verdict === "different-business" ? "This export looks like it's from a different business" : "This export may be from a different business",
      explanation: `Only ${m.customers.matched} of ${m.customers.of} customers, ${m.vendors.matched} of ${m.vendors.of} vendors and ${m.accounts.matched} of ${m.accounts.of} account names in the export were found in the connected business. Check that the export was requested with the right business selected in Wave.`,
      options: [{ value: "same", label: "It is the right business" }],
      refs: [],
    });
  }

  return { checks, issues };
}
