import { qbo, type CheckResult } from "@wave-exit/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServices } from "../app/context.tsx";
import type { Session } from "../app/session.ts";
import type { Problem } from "../engine/protocol.ts";
import { HelpLink } from "../help/HelpPanel.tsx";
import { INTUIT_DEV_KEYS, qboTokensName, type QboState } from "../store/projects.ts";
import { Dialog, Money, plural, ProblemBox, Progress, StatusBadge } from "./common.tsx";

/**
 * Loading the books into QuickBooks Online: connect (a sandbox company first),
 * check the company, map the accounts, preview, load (pausable, resumable),
 * check QuickBooks against the books, and undo. Uses the core library's load plan,
 * so what's previewed is exactly what's sent.
 */

const ENTITY_LABEL: Record<string, string> = {
  Account: "Accounts", Customer: "Customers", Vendor: "Vendors", Item: "Products and services", Invoice: "Invoices", Bill: "Bills",
  Payment: "Customer payments", BillPayment: "Bill payments", Purchase: "Expenses and card charges", Deposit: "Deposits", SalesReceipt: "Sales receipts",
  Transfer: "Transfers", CreditCardPayment: "Credit card payments", JournalEntry: "Journal entries",
};
const TXN = new Set(["Invoice", "Bill", "Payment", "BillPayment", "Purchase", "Deposit", "SalesReceipt", "Transfer", "CreditCardPayment", "JournalEntry"]);

interface DevKeys { clientId: string; clientSecret: string }

const toProblem = (e: unknown): Problem => {
  const w = qbo.explainQboError(e);
  return { code: "qbo", explanation: w.explanation, nextStep: w.nextStep, detail: w.detail };
};

export function QboLoad({ session, onClose }: { session: Session; onClose: () => void }) {
  const { platform } = useServices();
  const books = session.result?.books;
  const state = session.project.qbo;
  const [devKeys, setDevKeys] = useState<DevKeys | null | undefined>(undefined);
  const [env, setEnv] = useState<"sandbox" | "production">(state?.environment ?? "sandbox");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [company, setCompany] = useState<qbo.ExistingCompany | null>(null);
  const [existingTxns, setExistingTxns] = useState<number | null>(null);
  const [confirmLoad, setConfirmLoad] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    void platform.keychain.get(INTUIT_DEV_KEYS).then((v) => setDevKeys(v ? (JSON.parse(v) as DevKeys) : null));
  }, [platform]);

  const saveState = (change: (s: QboState) => QboState) => session.update((p) => ({ ...p, qbo: change(p.qbo!) }));

  /** A client for the connected company, refreshing and storing tokens as it goes. */
  const clientFor = async (s: QboState): Promise<qbo.QboClient> => {
    const raw = await platform.keychain.get(qboTokensName(session.project.id, s.realmId));
    if (!raw || !devKeys) throw new Error("not connected");
    const exchanger = qbo.directExchanger({ ...devKeys, fetch: platform.qbo.fetch as unknown as typeof fetch });
    const credentials = qbo.intuitCredentials({
      tokens: JSON.parse(raw) as qbo.IntuitTokens, exchanger,
      onTokens: (t) => platform.keychain.set(qboTokensName(session.project.id, s.realmId), JSON.stringify(t)),
    });
    return new qbo.QboClient({ environment: s.environment, realmId: s.realmId, credentials, fetch: platform.qbo.fetch });
  };

  const readCompany = async (s: QboState) => {
    setBusy("Reading the company's chart of accounts, contacts and products…");
    try {
      const c = await clientFor(s);
      const co: qbo.ExistingCompany = { accounts: await c.query("Account"), customers: await c.query("Customer"), vendors: await c.query("Vendor"), items: await c.query("Item") };
      let n = 0;
      for (const t of ["Invoice", "Bill", "Purchase", "Deposit", "JournalEntry", "Payment"]) n += await c.count(t);
      setCompany(co);
      setExistingTxns(n);
    } catch (e) {
      setProblem(toProblem(e));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (state && devKeys && !company && !busy) void readCompany(state);
  }, [state?.realmId, devKeys]);

  const plan = useMemo(() => (books && company ? qbo.buildLoadPlan(books, company, { accountOverrides: state?.overrides ?? {} }) : null), [books, company, state?.overrides]);
  const preview = useMemo(() => (books && plan && company ? qbo.previewPlan(books, plan, company) : null), [books, plan, company]);

  const connect = async () => {
    if (!devKeys) return;
    setProblem(null);
    setBusy("Waiting for you to approve Wave Exit in QuickBooks (in your web browser)…");
    try {
      const stateParam = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
      const reply = await platform.qbo.signIn(qbo.intuitAuthorizeUrl({ clientId: devKeys.clientId, redirectUri: platform.qbo.redirectUri, state: stateParam }));
      const { code, realmId } = qbo.parseIntuitRedirect(reply, stateParam);
      setBusy("Finishing the connection…");
      const tokens = await qbo.directExchanger({ ...devKeys, fetch: platform.qbo.fetch as unknown as typeof fetch }).exchangeCode(code, platform.qbo.redirectUri);
      await platform.keychain.set(qboTokensName(session.project.id, realmId), JSON.stringify(tokens));
      const s: QboState = { environment: env, realmId, companyName: "", overrides: state?.realmId === realmId ? state.overrides : {}, confirmedNotEmpty: false, record: state?.realmId === realmId ? state.record : null, lastCheck: null };
      const c = await clientFor(s);
      s.companyName = (await c.companyInfo()).CompanyName;
      await session.update((p) => ({ ...p, qbo: s }));
      setCompany(null);
      await readCompany(s);
    } catch (e) {
      setProblem(e instanceof Error && !(e instanceof qbo.QboError) ? { code: "qbo-signin", explanation: e.message, nextStep: "Try connecting again." } : toProblem(e));
    } finally {
      setBusy(null);
    }
  };

  const runLoad = async () => {
    if (!state || !plan || !books) return;
    setConfirmLoad(false);
    setProblem(null);
    abort.current = new AbortController();
    const record = state.record ?? qbo.newLoadRecord(state.environment, state.realmId, state.companyName);
    try {
      const c = await clientFor(state);
      setProgress({ done: record.created.length, total: plan.ops.length, label: "Starting…" });
      await qbo.runLoad(plan, c, record, {
        save: (r) => saveState((s) => ({ ...s, record: structuredClone(r) })),
        onProgress: (p) => setProgress({ done: p.done, total: p.total, label: p.label }),
        signal: abort.current.signal,
      });
      if (record.status === "finished") {
        setBusy("Checking QuickBooks against the books…");
        const check = await qbo.verifyLoad(books, plan, record, c);
        await saveState((s) => ({ ...s, record: structuredClone(record), lastCheck: check }));
      }
    } catch (e) {
      setProblem(toProblem(e));
    } finally {
      setBusy(null);
      setProgress(null);
      abort.current = null;
    }
  };

  const runUndo = async () => {
    if (!state?.record) return;
    setConfirmUndo(false);
    setProblem(null);
    const record = structuredClone(state.record);
    try {
      const c = await clientFor(state);
      setProgress({ done: 0, total: record.created.length, label: "Removing…" });
      await qbo.undoLoad(c, record, { save: (r) => saveState((s) => ({ ...s, record: structuredClone(r), lastCheck: null })), onProgress: (p) => setProgress({ done: p.done, total: p.total, label: p.label }) });
      setCompany(null);
      await readCompany({ ...state, record });
    } catch (e) {
      setProblem(toProblem(e));
    } finally {
      setProgress(null);
    }
  };

  if (!books) return null;
  const exp = books.business.exponent;
  const record = state?.record ?? null;
  const loadedTxns = record ? record.created.filter((c) => TXN.has(c.entity)).length : 0;
  const realLabel = state?.environment === "production" ? "real company" : "sandbox (test) company";

  return (
    <div className="stack">
      <div className="spread">
        <div>
          <h2>Load into QuickBooks Online</h2>
          <p className="small muted">History arrives as real QuickBooks transactions (expenses, deposits, transfers, invoices and payments), so banking, vendor and sales reports work. <HelpLink to="qbo-load">How it works</HelpLink></p>
        </div>
        <button className="button" onClick={onClose}>Back to outputs</button>
      </div>

      {!platform.qbo.available ? <div className="banner amber">{platform.qbo.reason}</div> : null}
      {problem ? <ProblemBox problem={problem} onDismiss={() => setProblem(null)} /> : null}

      {/* 1. Connect */}
      <section className="card stack">
        <h3>1. Connect to QuickBooks</h3>
        {devKeys === null ? <DevKeysForm onSaved={(k) => setDevKeys(k)} /> : null}
        {state ? (
          <div className="banner green">
            <strong>✓ Connected to {state.companyName}</strong> ({state.environment === "sandbox" ? "sandbox test company" : "real company"}).
          </div>
        ) : null}
        <fieldset className="choice" style={{ border: "none", padding: 0, margin: 0 }}>
          <legend className="small muted" style={{ marginBottom: 6 }}>Which company?</legend>
          <label><input type="radio" name="qbo-env" checked={env === "sandbox"} onChange={() => setEnv("sandbox")} />
            <span><strong>A sandbox (test) company</strong> <span className="badge green">Recommended first</span><br /><span className="small muted">Load here first, check it, then undo and load the real company.</span></span></label>
          <label><input type="radio" name="qbo-env" checked={env === "production"} disabled onChange={() => setEnv("production")} />
            <span><strong>The real company</strong> <span className="badge">Coming</span><br /><span className="small muted">Intuit's developer keys reach only sandbox companies. Loading a real company needs Wave Exit's own QuickBooks connection, which is being registered with Intuit.</span></span></label>
        </fieldset>
        <div className="row">
          <button className="button primary" disabled={!devKeys || !!busy || !platform.qbo.available} onClick={() => void connect()}>{state ? "Connect to a different company" : "Connect to QuickBooks"}</button>
          {devKeys ? <button className="button link small" onClick={() => void platform.keychain.remove(INTUIT_DEV_KEYS).then(() => setDevKeys(null))}>Change developer keys</button> : null}
        </div>
      </section>

      {/* 2. Company check */}
      {state && company && existingTxns !== null ? (
        <section className="card stack">
          <h3>2. The company</h3>
          {existingTxns > 0 ? (
            <div className="banner amber stack">
              <p><strong>{state.companyName} already has {plural(existingTxns, "transaction")}.</strong> Loading into an empty company is safest: anything already there will also show up in the final check, and the same transactions may end up recorded twice.</p>
              <label className="row"><input type="checkbox" checked={state.confirmedNotEmpty} onChange={(e) => void saveState((s) => ({ ...s, confirmedNotEmpty: e.target.checked }))} /> I understand, load into this company anyway.</label>
            </div>
          ) : <p className="small">✓ The company has no transactions yet.</p>}
        </section>
      ) : null}

      {/* 3. Accounts */}
      {state && plan && company && preview ? (
        <section className="card stack">
          <h3>3. Accounts</h3>
          <p className="small muted">Each Wave account either matches an account the company already has, or is created. Change any of them here.</p>
          <div className="scroll-x">
            <table className="data">
              <thead><tr><th>Wave account</th><th>In QuickBooks</th><th>Why</th></tr></thead>
              <tbody>
                {[...plan.mapping.choices].map(([id, c]) => {
                  const a = books.accounts.find((x) => x.id === id);
                  const cls = qbo.CLASSIFICATION[qbo.qboTypeFor(a ?? books.accounts[0]!).AccountType];
                  const options = company.accounts.filter((x) => x.Active !== false && qbo.CLASSIFICATION[x.AccountType] === cls);
                  return (
                    <tr key={id}>
                      <td>{a?.name ?? id}</td>
                      <td>
                        <select aria-label={`QuickBooks account for ${a?.name ?? id}`} value={c.kind === "existing" ? c.qboId : "create"}
                          onChange={(e) => void saveState((s) => ({ ...s, overrides: { ...s.overrides, [id]: e.target.value } }))}>
                          <option value="create">{c.kind === "create" ? `New: ${c.name} (${c.type.AccountType})` : "Create a new account"}</option>
                          {options.map((o) => <option key={o.Id} value={o.Id}>{o.Name} ({o.AccountType})</option>)}
                        </select>
                      </td>
                      <td className="small muted">{plan.mapping.reasons.get(id)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* 4. Preview */}
      {state && plan && preview ? (
        <section className="card stack">
          <h3>4. Preview</h3>
          <div className="scroll-x">
            <table className="data">
              <thead><tr><th>What</th><th className="num">How many</th></tr></thead>
              <tbody>{preview.counts.map((c) => <tr key={c.entity}><td>{ENTITY_LABEL[c.entity] ?? c.entity}</td><td className="num">{c.count.toLocaleString("en-US")}</td></tr>)}</tbody>
            </table>
          </div>
          {preview.differences.length ? (
            <div className="banner red">
              <strong>The load wouldn't match the books for {plural(preview.differences.length, "account")}, so it's blocked.</strong> Copy the details for support.
            </div>
          ) : <p className="small">✓ What will be loaded adds up to the books, account by account.</p>}
          <details>
            <summary className="small">Amount going into each account</summary>
            <table className="data">
              <thead><tr><th>Wave account</th><th>QuickBooks account</th><th className="num">Net debit (credit)</th></tr></thead>
              <tbody>{preview.accounts.map((a) => <tr key={a.accountId}><td>{a.name}</td><td className="small">{a.target}</td><td className="num"><Money value={a.planned} exponent={exp} /></td></tr>)}</tbody>
            </table>
          </details>
          {preview.skipped.length ? <p className="small muted">{plural(preview.skipped.length, "transaction")} left out: {preview.skipped.map((s) => s.why).join(" ")}</p> : null}
          <ul className="plain small">
            <li>Invoices are loaded with online payment turned off, so QuickBooks won't email them to your client's customers.</li>
            <li>Each record notes its Wave transaction number, and running the load again never creates duplicates.</li>
            <li>If the company is connected to the bank, start its bank feed the day after the last date here, or match feed items instead of adding them.</li>
          </ul>
          <div className="row">
            <button className="button primary"
              disabled={!!busy || !!progress || !!preview.differences.length || (existingTxns ?? 0) > 0 && !state.confirmedNotEmpty || record?.status === "finished"}
              onClick={() => setConfirmLoad(true)}>
              {record && (record.status === "paused" || record.status === "failed") ? "Continue loading" : `Load into ${state.companyName}`}
            </button>
            {progress && abort.current ? <button className="button" onClick={() => abort.current?.abort()}>Pause</button> : null}
          </div>
        </section>
      ) : null}

      {busy ? <Progress text={busy} /> : null}
      {progress ? (
        <div className="card stack" role="status" aria-live="polite">
          <progress max={progress.total} value={progress.done} style={{ width: "100%" }} />
          <span className="small">{progress.done.toLocaleString("en-US")} of {progress.total.toLocaleString("en-US")}: {progress.label}</span>
        </div>
      ) : null}

      {/* 5. Result */}
      {record && record.status !== "not-started" ? (
        <section className="card stack">
          <h3>5. Result</h3>
          <p>
            <StatusBadge status={record.status === "finished" ? "green" : record.status === "undone" ? "skipped" : "amber"}>
              {{ finished: "Loaded", paused: "Paused", failed: "Stopped", running: "Loading", undoing: "Removing", undone: "Removed", "not-started": "" }[record.status]}
            </StatusBadge>{" "}
            {plural(loadedTxns, "transaction")} and {plural(record.created.length - loadedTxns, "list record")} in {state?.companyName}.
          </p>
          {record.failed.length ? (
            <div className="banner amber">
              <p><strong>{plural(record.failed.length, "record")} didn't go in.</strong> Everything before them is loaded; fix the first one and continue. Nothing is created twice.</p>
              <ul className="plain small">{record.failed.slice(0, 10).map((f) => <li key={f.key}><strong>{f.label}</strong>: {f.explanation} {f.nextStep}</li>)}</ul>
            </div>
          ) : null}
          {state?.lastCheck ? <CheckView check={state.lastCheck} /> : null}
          {record.status === "finished" ? (
            <div className="guide">
              <h3>Before you hand the company over</h3>
              <ol>
                <li>Open the trial balance and A/R and A/P aging in QuickBooks and compare them with Wave Exit's PDF report pack.</li>
                <li>Start the bank feeds from the day after {books.period.lastDate}, or match feed items instead of adding them.</li>
                <li>Set up sales tax in QuickBooks if the business charges it; historical tax came in as its own line.</li>
                <li>Keep Wave Exit's universal package and report pack in the client file.</li>
              </ol>
            </div>
          ) : null}
          {record.created.length ? (
            <div className="row"><button className="button danger" disabled={!!progress || !!busy} onClick={() => setConfirmUndo(true)}>Remove everything Wave Exit loaded</button></div>
          ) : null}
        </section>
      ) : null}

      {confirmLoad && state && plan ? (
        <Dialog title={`Load into ${state.companyName}?`} onClose={() => setConfirmLoad(false)}>
          <p>This adds {plural(plan.ops.filter((o) => TXN.has(o.entity)).length, "transaction")} and {plural(plan.ops.filter((o) => !TXN.has(o.entity)).length, "account, contact and product")} to <strong>{state.companyName}</strong>, a {realLabel}. You can pause at any time, and remove everything afterwards.</p>
          <div className="row"><button className="button primary" onClick={() => void runLoad()}>Load now</button><button className="button" onClick={() => setConfirmLoad(false)}>Cancel</button></div>
        </Dialog>
      ) : null}
      {confirmUndo && state && record ? (
        <Dialog title={`Remove everything from ${state.companyName}?`} onClose={() => setConfirmUndo(false)}>
          <p>This deletes the {plural(loadedTxns, "transaction")} Wave Exit loaded into <strong>{state.companyName}</strong> ({realLabel}), newest first, and makes its {plural(record.created.length - loadedTxns, "account, contact and product")} inactive (QuickBooks doesn't allow deleting those). Anything changed in QuickBooks since is left alone and listed.</p>
          <div className="row"><button className="button danger" onClick={() => void runUndo()}>Remove {plural(record.created.length, "record")}</button><button className="button" onClick={() => setConfirmUndo(false)}>Keep them</button></div>
        </Dialog>
      ) : null}
    </div>
  );
}

function CheckView({ check }: { check: CheckResult }) {
  return (
    <div className={`banner ${check.status === "green" ? "green" : "red"}`}>
      <p><StatusBadge status={check.status} /> <strong>{check.title}.</strong> {check.summary}</p>
      {check.details.length ? <ul className="plain small">{check.details.slice(0, 20).map((d) => <li key={d}>{d}</li>)}</ul> : null}
    </div>
  );
}

/**
 * Until Wave Exit's own QuickBooks app is registered with Intuit, a load connects
 * with the user's own Intuit developer keys (free; sandbox companies included).
 */
function DevKeysForm({ onSaved }: { onSaved: (k: DevKeys) => void }) {
  const { platform } = useServices();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  return (
    <div className="stack">
      <div className="guide">
        <h3>One-time setup: your Intuit developer keys</h3>
        <p className="small">Wave Exit's own QuickBooks connection isn't registered with Intuit yet, so for now loads use free Intuit developer keys you create yourself. They come with sandbox (test) companies to try it in.</p>
        <ol className="small">
          <li>Sign up at developer.intuit.com and create an app for QuickBooks Online (Accounting).</li>
          <li>In the app's Development settings, add this redirect URI exactly: <code>{platform.qbo.redirectUri}</code></li>
          <li>Copy the Development Client ID and Client Secret into the boxes below.</li>
        </ol>
        <HelpLink to="qbo-keys">Step-by-step help</HelpLink>
      </div>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); const k = { clientId: clientId.trim(), clientSecret: clientSecret.trim() }; void platform.keychain.set(INTUIT_DEV_KEYS, JSON.stringify(k)).then(() => onSaved(k)); }}>
        <label className="field"><span>Client ID</span><input type="text" autoComplete="off" spellCheck={false} value={clientId} onChange={(e) => setClientId(e.target.value)} /></label>
        <label className="field"><span>Client Secret</span><input type="password" autoComplete="off" spellCheck={false} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} /></label>
        <div className="row"><button className="button" type="submit" disabled={!clientId.trim() || !clientSecret.trim()}>Save in this computer's keychain</button></div>
      </form>
    </div>
  );
}
