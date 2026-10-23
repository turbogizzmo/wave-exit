import { useState, type ReactNode } from "react";
import { useServices } from "../app/context.tsx";
import type { Session } from "../app/session.ts";
import type { SlotId } from "../store/projects.ts";
import { formatDate, plural, ProblemBox } from "./common.tsx";
import { HelpLink } from "../help/HelpPanel.tsx";
import { Guide, WaveConnection } from "./WaveConnection.tsx";

/** Inputs: a slot for each source, what it holds, and what is lost without it. */

function Slot({ title, state, summary, children, actions }: { title: string; state: "ok" | "missing" | "bad"; summary: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card slot" aria-label={title}>
      <div className={`mark ${state}`} aria-hidden="true">{state === "ok" ? "✓" : state === "bad" ? "✕" : "○"}</div>
      <div className="stack">
        <div>
          <h2>{title}</h2>
          <div className="small">{summary}</div>
        </div>
        {children}
      </div>
      <div className="row">{actions}</div>
    </section>
  );
}

export function InputsScreen({ session, onPick }: { session: Session; onPick: (slot: SlotId, folder?: boolean) => void }) {
  const { platform } = useServices();
  const p = session.project;
  const r = session.result;
  const [guide, setGuide] = useState<SlotId | null>(null);
  const match = r?.businessMatch;

  const fileActions = (slot: SlotId, has: boolean) => (
    <>
      <button className="button" onClick={() => onPick(slot)}>{has ? "Replace with a newer export" : "Choose the ZIP file"}</button>
      {platform.kind === "desktop" ? <button className="button" onClick={() => onPick(slot, true)}>Choose a folder</button> : null}
    </>
  );

  return (
    <div className="stack">
      <div className="spread">
        <p className="muted" style={{ margin: 0 }}>Drop Wave's files anywhere on this window: Wave Exit works out which slot they go in. A ZIP, the unzipped folder or the individual files all work.</p>
        <HelpLink to="whose-books">Which files do I need?</HelpLink>
      </div>

      <Slot
        title="Transactions export"
        state={session.problems.transactions ? "bad" : p.inputs.transactions ? "ok" : "missing"}
        summary={p.inputs.transactions
          ? <>Loaded: {r?.summary.transactions ?? p.inputs.transactions.fileName}. <span className="muted">({p.inputs.transactions.fileName}, added {formatDate(p.inputs.transactions.addedAt)})</span></>
          : <><strong>Required.</strong> It is the only source of the ledger: nothing can be converted without it.</>}
        actions={fileActions("transactions", !!p.inputs.transactions)}
      >
        {match && match.verdict !== "same-business" ? (
          <div className={`banner ${match.verdict === "different-business" ? "red" : "amber"}`}>
            <strong>This export looks like it's from a different business than {p.wave?.businessName}.</strong>{" "}
            Only {match.customers.matched} of {match.customers.of} customers and {match.vendors.matched} of {match.vendors.of} vendors were found there. Check which business was selected in Wave when the export was made.
          </div>
        ) : null}
        {session.problems.transactions ? <ProblemBox problem={session.problems.transactions} onDismiss={() => session.clearProblem("transactions")} /> : null}
        {r?.readerNotes.length ? <ul className="plain small muted">{r.readerNotes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
        <button className="button link small" onClick={() => setGuide(guide === "transactions" ? null : "transactions")}>How do I get this?</button>
        {guide === "transactions" ? <Guide which="transactions" /> : null}
      </Slot>

      <Slot
        title="Wave connection"
        state={p.wave ? "ok" : p.whose === "client-no-access" ? "missing" : "missing"}
        summary={p.wave
          ? <>Connected: {p.wave.businessName}.</>
          : <><strong>Strongly recommended.</strong> Without it: no empty accounts or Wave account types, no invoice line items, products or estimates, and no check against Wave's balances.</>}
      >
        <WaveConnection session={session} />
        <div className="row"><HelpLink to="wave-connection">About connecting to Wave</HelpLink><HelpLink to="without-connection">Working without a connection</HelpLink></div>
      </Slot>

      <Slot
        title="Receipts export"
        state={session.problems.receipts ? "bad" : p.inputs.receipts ? "ok" : "missing"}
        summary={p.inputs.receipts ? <>Loaded: {r?.summary.receipts ?? p.inputs.receipts.fileName}.</> : <>Optional. Without it, outputs have no receipt files attached.</>}
        actions={<>
          {fileActions("receipts", !!p.inputs.receipts)}
          {p.inputs.receipts ? <button className="button" onClick={() => void session.removeInput("receipts")}>Remove</button> : null}
        </>}
      >
        {session.problems.receipts ? <ProblemBox problem={session.problems.receipts} onDismiss={() => session.clearProblem("receipts")} /> : null}
        <button className="button link small" onClick={() => setGuide(guide === "receipts" ? null : "receipts")}>How do I get this?</button>
        {guide === "receipts" ? <Guide which="receipts" /> : null}
      </Slot>

      <Slot title="Payroll exports" state="missing" summary={<>Optional. Wave offers payroll exports for <strong>Canadian businesses only</strong>, so US businesses have none to add. Reading them comes in a later version; without them there are no employee or pay stub records.</>} />

      <Slot title="Client collection file" state="missing" summary={<>An alternative to all the above, made by the client with Wave Exit and protected by a passphrase. Coming in a later version.</>} />

      {p.history.length ? (
        <details>
          <summary className="small">Earlier versions of these inputs ({plural(p.history.length, "replacement")})</summary>
          <ul className="plain small muted">{p.history.map((h, i) => <li key={i}>{h.slot === "wave" ? "Wave connection" : h.slot === "transactions" ? "Transactions export" : "Receipts export"}: {h.fileName}, added {formatDate(h.addedAt)}</li>)}</ul>
        </details>
      ) : null}
    </div>
  );
}
