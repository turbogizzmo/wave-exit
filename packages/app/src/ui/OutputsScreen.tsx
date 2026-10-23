import { OUTPUTS, type Issue, type OutputGroup } from "@wave-exit/core";
import { useEffect, useState } from "react";
import { useServices } from "../app/context.tsx";
import type { Session } from "../app/session.ts";
import { EngineError } from "../engine/client.ts";
import type { Problem } from "../engine/protocol.ts";
import { HelpLink } from "../help/HelpPanel.tsx";
import { formatDate, plural, ProblemBox, Progress } from "./common.tsx";
import { QboLoad } from "./QboLoad.tsx";

/** Outputs: tick any number of cards and press Create. The universal package is always made. */

const GROUPS: [OutputGroup, string][] = [["archive", "Archive"], ["review", "Review"], ["import-files", "Import files"], ["direct-load", "Direct load"], ["plain-text", "Plain-text accounting"]];

const COMING: { group: OutputGroup; title: string; summary: string }[] = [
  { group: "import-files", title: "QuickBooks Online import files", summary: "QuickBooks' own import templates, with history as journal entries." },
  { group: "import-files", title: "Xero import files", summary: "Xero's import files, with history as manual journals." },
  { group: "direct-load", title: "Load into Xero", summary: "The same, for Xero." },
  { group: "plain-text", title: "Beancount and hledger", summary: "One plain-text ledger file with balance checks." },
];

export function OutputsScreen({ session, goReview }: { session: Session; goReview: () => void }) {
  const { engine, platform } = useServices();
  const books = session.result?.books;
  const p = session.project;
  const [chosen, setChosen] = useState<Set<string>>(new Set(["universal-package"]));
  const [warnings, setWarnings] = useState<Record<string, Issue[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [done, setDone] = useState<{ folder: string; files: string[] } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingQbo, setLoadingQbo] = useState(false);

  useEffect(() => {
    if (books) void engine.validate().then(setWarnings, () => setWarnings({}));
  }, [engine, books]);

  if (!books) return <div className="card"><h2>No books yet</h2><p>Add the transactions export on the Inputs screen first.</p></div>;
  if (loadingQbo) return <QboLoad session={session} onClose={() => setLoadingQbo(false)} />;

  const toggle = (id: string) => setChosen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const create = async () => {
    setProblem(null);
    setDone(null);
    setBusy("Making the outputs…");
    try {
      const ids = [...chosen];
      const r = await engine.outputs({ ids, createdAt: new Date().toISOString(), options: p.outputOptions }, setBusy);
      setBusy("Saving…");
      const saved = await platform.saveOutputs(r.files, "");
      if (!saved) return;
      await session.update((x) => ({ ...x, outputs: [{ at: new Date().toISOString(), ids: [...new Set(r.files.map((f) => f.outputId))], folder: saved.folder, files: saved.written }, ...x.outputs] }));
      setDone({ folder: saved.folder, files: saved.written });
    } catch (e) {
      setProblem(e instanceof EngineError ? e.problem : { code: "unexpected", explanation: "The outputs couldn't be made.", nextStep: "Try again.", detail: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const unmatchedReceipts = books.receipts.filter((r) => r.status !== "linked").length;

  return (
    <div className="stack">
      {session.blocked ? (
        <div className="banner red">
          <strong>Outputs are waiting for {plural(session.blocked, "answer")} on the Review screen.</strong>{" "}
          <button className="button link" onClick={goReview}>Go to Review</button>
        </div>
      ) : null}

      <div className="row"><HelpLink to="which-output">Which output do I need?</HelpLink><HelpLink to="bank-files">Using the bank statement files</HelpLink></div>
      {GROUPS.map(([group, label]) => {
        const plugins = OUTPUTS.filter((o) => o.group === group);
        const coming = COMING.filter((c) => c.group === group);
        if (!plugins.length && !coming.length && group !== "direct-load") return null;
        return (
          <section key={group}>
            <div className="group-title">{label}</div>
            <div className="stack">
              {plugins.map((o) => {
                const d = o.describe(books);
                const w = warnings[o.id] ?? [];
                const id = `out-${o.id}`;
                return (
                  <div key={o.id} className="card output-card">
                    <input id={id} type="checkbox" checked={o.alwaysCreated || chosen.has(o.id)} disabled={o.alwaysCreated} onChange={() => toggle(o.id)} />
                    <div className="stack">
                      <label htmlFor={id}><h3>{o.title}{o.alwaysCreated ? <span className="badge" style={{ marginLeft: 8 }}>Always made</span> : null}</h3></label>
                      <p className="small">{o.summary}</p>
                      <div className="row" style={{ alignItems: "flex-start", gap: 24 }}>
                        <div style={{ flex: "1 1 280px" }}>
                          <div className="small muted">Keeps</div>
                          <ul className="keeps small plain">{(expanded.has(o.id) ? d.keeps : d.keeps.slice(0, 6)).map((k) => <li key={k.aspect}>{k.text}</li>)}</ul>
                          {d.keeps.length > 6 ? <button className="button link small" onClick={() => setExpanded((s) => { const n = new Set(s); if (n.has(o.id)) n.delete(o.id); else n.add(o.id); return n; })}>{expanded.has(o.id) ? "Show fewer" : `Show all ${d.keeps.length}`}</button> : null}
                        </div>
                        {d.loses.length ? <div style={{ flex: "1 1 280px" }}><div className="small muted">Loses</div><ul className="loses small plain">{d.loses.map((l) => <li key={l.aspect}>{l.text}</li>)}</ul></div> : null}
                      </div>
                      {d.withoutConnection.length ? <p className="small muted">Without a Wave connection: {d.withoutConnection.join("; ")}.</p> : null}
                      {w.map((i) => <div key={i.id} className={`banner small ${i.severity === "red" ? "red" : "amber"}`}><strong>{i.title}.</strong> {i.explanation}</div>)}
                      {o.id === "bank-statements" && chosen.has(o.id) ? (
                        <label className="field">
                          <span>Bank's Intuit ID, for QuickBooks .qbo files (optional; find &lt;INTU.BID&gt; in a .qbo file from the bank)</span>
                          <input type="text" inputMode="numeric" value={String(p.outputOptions["bank-statements"]?.intuitBid ?? "")} style={{ maxWidth: 200 }}
                            onChange={(e) => void session.update((x) => ({ ...x, outputOptions: { ...x.outputOptions, "bank-statements": { ...x.outputOptions["bank-statements"], intuitBid: e.target.value.replace(/[^0-9A-Za-z]/g, "") } } }))} />
                        </label>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {group === "direct-load" ? (
                <div className="card output-card">
                  <span aria-hidden="true" style={{ width: 18 }} />
                  <div className="stack">
                    <h3>Load into QuickBooks Online {p.qbo?.record?.status === "finished" ? <span className="badge green">Loaded into {p.qbo.companyName}</span> : null}</h3>
                    <p className="small">History as real QuickBooks transactions (expenses, deposits, transfers, invoices and payments), with a preview first, pause and continue, a check against QuickBooks's own reports, and undo.</p>
                    <div className="row" style={{ alignItems: "flex-start", gap: 24 }}>
                      <div style={{ flex: "1 1 280px" }}><div className="small muted">Keeps</div><ul className="keeps small plain"><li>Every transaction, as the matching QuickBooks type</li><li>Invoices and bills linked to their payments, so aging works</li><li>Customers, vendors and the chart of accounts</li></ul></div>
                      <div style={{ flex: "1 1 280px" }}><div className="small muted">Loses</div><ul className="loses small plain"><li>Receipt files (keep the universal package)</li><li>Sales tax as QuickBooks calculates it: historical tax comes in as its own line</li></ul></div>
                    </div>
                    <div className="row">
                      <button className="button" disabled={!!session.blocked} onClick={() => setLoadingQbo(true)}>{p.qbo ? "Open the QuickBooks load" : "Set up loading into QuickBooks"}</button>
                      <HelpLink to="qbo-load">How it works</HelpLink>
                    </div>
                  </div>
                </div>
              ) : null}
              {coming.map((c) => (
                <div key={c.title} className="card output-card" aria-disabled="true" style={{ opacity: 0.6 }}>
                  <input type="checkbox" disabled aria-label={`${c.title} (not available yet)`} />
                  <div><h3>{c.title} <span className="badge">Coming later</span></h3><p className="small">{c.summary}</p></div>
                </div>
              ))}
            </div>
          </section>
        );
      })}

      <div className="row">
        <button className="button primary" disabled={!!session.blocked || !!busy} onClick={() => void create()}>Create {plural(chosen.size, "output")}</button>
        <span className="small muted">You choose where to save them.</span>
      </div>
      {busy ? <Progress text={busy} /> : null}
      {problem ? <ProblemBox problem={problem} onDismiss={() => setProblem(null)} /> : null}
      {done ? (
        <div className="banner green" role="status">
          <strong>Saved {plural(done.files.length, "file")}</strong> to {done.folder}.{" "}
          {platform.kind === "desktop" ? <button className="button link" onClick={() => void platform.revealFolder(done.files[0] ?? done.folder)}>Show in folder</button> : null}
        </div>
      ) : null}

      {p.outputs.length ? (
        <section className="card">
          <h2>Made so far</h2>
          <table className="data">
            <thead><tr><th>When</th><th>Outputs</th><th>Where</th></tr></thead>
            <tbody>{p.outputs.map((o, i) => (
              <tr key={i}><td>{formatDate(o.at)}</td><td>{o.ids.map((id) => OUTPUTS.find((x) => x.id === id)?.title ?? id).join(", ")}</td><td className="small">{o.folder}</td></tr>
            ))}</tbody>
          </table>
          <p className="small muted">After a newer export, tick the same cards and create them again.</p>
        </section>
      ) : null}

      <section className="card">
        <h2>Not available from Wave</h2>
        <p className="small">These can't be read from Wave by any supported route, so no output has them:</p>
        <ul className="plain small">
          <li>Recurring invoice schedules</li>
          <li>Bank reconciliation status</li>
          <li>Bank-feed connections</li>
          <li>Payroll detail beyond Wave's payroll exports (Canada only)</li>
          {unmatchedReceipts ? <li>{plural(unmatchedReceipts, "receipt")} that couldn't be linked to a transaction (they're kept as unlinked attachments)</li> : null}
        </ul>
        <p className="small">For each closed year, keep the PDF report pack in the client file.</p>
      </section>
    </div>
  );
}
