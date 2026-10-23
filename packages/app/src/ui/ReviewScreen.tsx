import { sum, type AgingBucket, type AgingRow, type Books, type Issue } from "@wave-exit/core";
import { useMemo, useState } from "react";
import type { Session } from "../app/session.ts";
import { formatDate, Money, plural, ProblemBox, Progress, StatusBadge } from "./common.tsx";

/** Review: the checks, the questions that need a person, the settings, and open items. */

const KIND_TITLE: Partial<Record<Issue["kind"], string>> = {
  "receipt-ambiguous": "Receipts that fit more than one transaction",
  "receipt-unmatched": "Receipts that don't match a transaction",
  "unpaired-transfer": "Transfers with no other side",
  "invoice-mismatch": "Invoices whose amounts don't agree",
  "payment-unlinked": "Payments that couldn't be linked",
};

const TYPE_LABEL: Record<string, string> = {
  expense: "Expenses", refund: "Refunds", deposit: "Deposits", "sales-receipt": "Sales receipts", transfer: "Transfers",
  "credit-card-payment": "Credit card payments", invoice: "Invoices", "invoice-payment": "Invoice payments", bill: "Bills",
  "bill-payment": "Bill payments", journal: "Journal entries",
};

function IssueCard({ issue, onAnswer }: { issue: Issue; onAnswer: (value: string | null) => void }) {
  const [choice, setChoice] = useState(issue.options[0]?.value ?? "");
  const answered = issue.resolution ? (issue.options.find((o) => o.value === issue.resolution)?.label ?? (issue.resolution === "noted" ? "Noted" : issue.resolution)) : null;
  return (
    <div className={`card stack`} style={{ borderLeft: `4px solid var(--${issue.resolution ? "border" : issue.severity === "red" ? "red" : "amber"})` }}>
      <div className="spread">
        <h3>{issue.title}</h3>
        {answered ? <StatusBadge status="green">Answered</StatusBadge> : <StatusBadge status={issue.severity} />}
      </div>
      <p className="small">{issue.explanation}</p>
      {answered ? (
        <div className="row small">
          <span>Answer: <strong>{answered}</strong></span>
          <button className="button link small" onClick={() => onAnswer(null)}>Change</button>
        </div>
      ) : issue.options.length > 1 ? (
        <div className="row">
          <select aria-label={`Answer for: ${issue.title}`} value={choice} onChange={(e) => setChoice(e.target.value)} style={{ maxWidth: "100%" }}>
            {issue.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button className="button primary" onClick={() => onAnswer(choice)}>Use this answer</button>
        </div>
      ) : issue.options.length === 1 ? (
        <div className="row"><button className="button primary" onClick={() => onAnswer(issue.options[0]!.value)}>{issue.options[0]!.label}</button></div>
      ) : (
        <div className="row"><button className="button" onClick={() => onAnswer("noted")}>I've looked at this</button></div>
      )}
    </div>
  );
}

const BUCKETS: AgingBucket[] = ["current", "1-30", "31-60", "61-90", "90+"];

function Aging({ title, rows, books, unknownNote }: { title: string; rows: AgingRow[]; books: Books; unknownNote: string }) {
  const names = new Map(books.contacts.map((c) => [c.id, c.name] as const));
  const exp = books.business.exponent;
  const totals = BUCKETS.map((b) => sum(rows.filter((r) => r.bucket === b).map((r) => r.amountDue)));
  return (
    <div className="card stack">
      <h3>{title}</h3>
      {rows.length === 0 ? <p className="small muted">Nothing open at the cutover date.</p> : (
        <div className="scroll-x">
          <table className="data">
            <thead><tr><th>Number</th><th>Contact</th><th>Date</th><th>Due</th>{BUCKETS.map((b) => <th key={b} className="num">{b === "current" ? "Current" : `${b} days`}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.documentId}>
                  <td>{r.number}</td><td>{names.get(r.contactId) ?? ""}</td><td>{formatDate(r.date)}</td>
                  <td>{r.dueDateKnown ? formatDate(r.dueDate) : <span className="muted">not known</span>}</td>
                  {BUCKETS.map((b) => <td key={b} className="num">{r.bucket === b ? <Money value={r.amountDue} exponent={exp} /> : ""}</td>)}
                </tr>
              ))}
              <tr><td colSpan={4}><strong>Total</strong></td>{totals.map((t, i) => <td key={i} className="num"><strong><Money value={t} exponent={exp} /></strong></td>)}</tr>
            </tbody>
          </table>
        </div>
      )}
      {rows.some((r) => !r.dueDateKnown) ? <p className="small muted">{unknownNote}</p> : null}
    </div>
  );
}

export function ReviewScreen({ session }: { session: Session }) {
  const r = session.result;
  const [showAllOf, setShowAllOf] = useState<string | null>(null);
  const books = r?.books;

  const groups = useMemo(() => {
    if (!books) return [];
    const order = (i: Issue) => (i.resolution ? 2 : i.severity === "red" ? 0 : 1);
    const sorted = [...books.issues].sort((a, b) => order(a) - order(b));
    const m = new Map<string, Issue[]>();
    for (const i of sorted) {
      const k = KIND_TITLE[i.kind] ? i.kind : `single:${i.id}`;
      m.set(k, [...(m.get(k) ?? []), i]);
    }
    return [...m.entries()];
  }, [books]);

  if (session.building) return <Progress text={session.building} />;
  if (session.problems.build) return <ProblemBox problem={session.problems.build} />;
  if (!books) return <div className="card"><h2>Nothing to review yet</h2><p>Add the transactions export on the Inputs screen first.</p></div>;

  const answer = (id: string, value: string | null) =>
    session.setSettings((s) => {
      const resolutions = { ...s.resolutions };
      if (value === null) delete resolutions[id];
      else resolutions[id] = value;
      return { ...s, resolutions };
    });

  const open = books.issues.filter((i) => !i.resolution);
  const red = open.filter((i) => i.severity === "red").length + books.checks.filter((c) => c.status === "red").length;
  const typeCounts = new Map<string, number>();
  for (const e of books.entries) typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
  const rules = books.rules;

  return (
    <div className="stack">
      <div className={`banner ${red ? "red" : open.length ? "amber" : "green"}`} role="status">
        {red
          ? <><strong>{plural(red, "item")} to answer</strong> before outputs can be made.</>
          : open.length ? <><strong>Ready for outputs.</strong> {plural(open.length, "note")} to look at below.</> : <><strong>Every check passed.</strong> Ready for outputs.</>}
        <span className="small"> {plural(books.entries.length, "transaction")}, {formatDate(books.period.firstDate)} to {formatDate(books.period.lastDate)}. {books.mode === "export-file-only" ? "From the export files only (no Wave connection)." : ""}</span>
      </div>

      <section className="card">
        <h2>Checks</h2>
        {books.checks.map((c) => (
          <details key={c.id} className="check">
            <summary><StatusBadge status={c.status} /><span><strong>{c.title}.</strong> {c.summary}</span></summary>
            {c.details.length ? <ul>{c.details.slice(0, 50).map((d, i) => <li key={i}>{d}</li>)}</ul> : null}
          </details>
        ))}
      </section>

      <section className="stack">
        <h2>Questions and notes</h2>
        {groups.length === 0 ? <p className="muted">Nothing needs a person's attention.</p> : groups.map(([k, items]) => {
          if (k.startsWith("single:")) return <IssueCard key={k} issue={items[0]!} onAnswer={(v) => void answer(items[0]!.id, v)} />;
          const shown = showAllOf === k ? items : items.slice(0, 3);
          const unanswered = items.filter((i) => !i.resolution).length;
          return (
            <div key={k} className="stack">
              <h3>{KIND_TITLE[items[0]!.kind]} <span className="muted small">({unanswered} of {items.length} to look at)</span></h3>
              {shown.map((i) => <IssueCard key={i.id} issue={i} onAnswer={(v) => void answer(i.id, v)} />)}
              {items.length > 3 ? <button className="button link small" onClick={() => setShowAllOf(showAllOf === k ? null : k)}>{showAllOf === k ? "Show fewer" : `Show all ${items.length}`}</button> : null}
            </div>
          );
        })}
      </section>

      <section className="card stack">
        <h2>Settings for every output</h2>
        <label className="field">
          <span>Cutover date: the day the books move to the new system</span>
          <input type="date" value={books.period.cutoverDate} min={books.period.firstDate} max={books.period.lastDate}
            onChange={(e) => e.target.value && void session.setSettings((s) => ({ ...s, cutoverDate: e.target.value }))} />
        </label>
        <fieldset className="choice" style={{ border: "none", padding: 0, margin: 0 }}>
          <legend className="small muted" style={{ marginBottom: 6 }}>What to carry into the new system</legend>
          <label><input type="radio" name="scope" checked={books.settings.scope === "full-history"} onChange={() => void session.setSettings((s) => ({ ...s, scope: "full-history" }))} />
            <span><strong>Full history</strong><br /><span className="small muted">Every transaction since the business started in Wave.</span></span></label>
          <label><input type="radio" name="scope" checked={books.settings.scope === "opening-balances"} onChange={() => void session.setSettings((s) => ({ ...s, scope: "opening-balances" }))} />
            <span><strong>Opening balances at the cutover date</strong>, plus every open invoice and bill<br /><span className="small muted">Balances on {formatDate(books.period.cutoverDate)}, the year to date by account, and everything after that day.</span></span></label>
        </fieldset>
        <label className="field">
          <span>Fiscal year ends in</span>
          <select value={books.settings.fiscalYearEndMonth ?? 12} onChange={(e) => void session.setSettings((s) => ({ ...s, fiscalYearEndMonth: Number(e.target.value) }))}>
            {["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </label>
      </section>

      <section className="stack">
        <h2>Open items at {formatDate(books.period.cutoverDate)}</h2>
        <Aging title="Accounts receivable" rows={books.agingAr} books={books} unknownNote="Invoice due dates come from the Wave connection; without one, invoices are aged from their invoice date." />
        <Aging title="Accounts payable" rows={books.agingAp} books={books} unknownNote="Some bills' due dates weren't in the export in a form Wave Exit can read, so those bills are aged from their bill date." />
      </section>

      <section className="card stack">
        <h2>How transactions were sorted</h2>
        <div className="scroll-x">
          <table className="data">
            <thead><tr><th>Type</th><th className="num">Count</th></tr></thead>
            <tbody>{[...typeCounts.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => <tr key={t}><td>{TYPE_LABEL[t] ?? t}</td><td className="num">{n.toLocaleString("en-US")}</td></tr>)}</tbody>
          </table>
        </div>
        <details>
          <summary className="small">Sorting rules (advanced)</summary>
          <p className="small muted" style={{ marginTop: 8 }}>Wave Exit sorts each transaction by the kinds of account on its lines. The first rule that fits wins; anything else is a journal entry. Turn a rule off to treat those transactions as journal entries.</p>
          <table className="data">
            <thead><tr><th>On</th><th>Rule</th><th>What it means</th></tr></thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td><input type="checkbox" aria-label={`Use rule: ${rule.label}`} checked={rule.enabled}
                    onChange={(e) => void session.setSettings((s) => ({ ...s, rules: rules.map((x) => (x.id === rule.id ? { ...x, enabled: e.target.checked } : x)) }))} /></td>
                  <td>{rule.label}</td><td className="small">{rule.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {books.settings.rules ? <button className="button small" onClick={() => void session.setSettings((s) => { const { rules: _r, ...rest } = s; return rest; })}>Back to the standard rules</button> : null}
        </details>
      </section>
    </div>
  );
}
