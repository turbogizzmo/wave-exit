import { fetchWaveSnapshot, fullAccessKey, InputProblem, listBusinesses, WaveClient, whoAmI, type WaveBusinessSummary } from "@wave-exit/core";
import { useEffect, useState } from "react";
import { useServices } from "../app/context.tsx";
import type { Session } from "../app/session.ts";
import type { Problem } from "../engine/protocol.ts";
import { waveKeyName, type Whose } from "../store/projects.ts";
import { formatDate, ProblemBox, Progress } from "./common.tsx";
import { EXPORT_ONLY_LOSSES, GUIDES, WAVE_KEY_PAGE } from "./guides.ts";

/**
 * The Wave connection slot: whose books these are, then a Wave access key (kept
 * in the keychain, one per project), then the business. "Connect to Wave" (OAuth)
 * can drop in here later: Wave allows it only for Pro or Advisor businesses.
 */

const toProblem = (e: unknown): Problem =>
  e instanceof InputProblem
    ? { code: e.code, explanation: e.explanation, nextStep: e.nextStep, ...(e.detail ? { detail: e.detail } : {}) }
    : { code: "unexpected", explanation: "Wave Exit couldn't talk to Wave.", nextStep: "Check the internet connection and try again.", detail: String(e) };

export function WaveConnection({ session }: { session: Session }) {
  const { platform } = useServices();
  const p = session.project;
  const [keyText, setKeyText] = useState("");
  const [haveKey, setHaveKey] = useState<boolean | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [businesses, setBusinesses] = useState<WaveBusinessSummary[] | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [showGuide, setShowGuide] = useState(false);

  useEffect(() => {
    void platform.keychain.get(waveKeyName(p.id)).then((k) => setHaveKey(!!k));
  }, [platform, p.id]);

  const client = async () => {
    const key = await platform.keychain.get(waveKeyName(p.id));
    if (!key) throw new InputProblem("wave-key-rejected", "There's no Wave access key for this project yet.", "Paste one below.");
    return new WaveClient({ credentials: fullAccessKey(key), fetch: platform.waveFetch, url: platform.waveUrl });
  };

  const checkKey = async (key: string) => {
    setProblem(null);
    setBusy("Checking the key with Wave…");
    try {
      const c = new WaveClient({ credentials: fullAccessKey(key), fetch: platform.waveFetch, url: platform.waveUrl });
      const user = await whoAmI(c);
      await platform.keychain.set(waveKeyName(p.id), key.trim());
      setHaveKey(true);
      setKeyText("");
      setEmail(user.email);
      setBusinesses(await listBusinesses(c));
    } catch (e) {
      setProblem(toProblem(e));
    } finally {
      setBusy(null);
    }
  };

  const loadBusinesses = async () => {
    setProblem(null);
    setBusy("Asking Wave for the businesses this key can see…");
    try {
      const c = await client();
      setEmail((await whoAmI(c)).email);
      setBusinesses(await listBusinesses(c));
    } catch (e) {
      setProblem(toProblem(e));
    } finally {
      setBusy(null);
    }
  };

  const pick = async (b: WaveBusinessSummary) => {
    setProblem(null);
    setBusy(`Reading ${b.name} from Wave…`);
    try {
      const c = await client();
      const snap = await fetchWaveSnapshot(c, b.id, { onProgress: (step, n) => setBusy(`Reading ${b.name} from Wave: ${n.toLocaleString("en-US")} ${step.replace(/([A-Z])/g, " $1").toLowerCase()}…`) });
      setBusinesses(null);
      await session.setWave(snap, email ?? "");
    } catch (e) {
      setProblem(toProblem(e));
    } finally {
      setBusy(null);
    }
  };

  const forget = async () => {
    await platform.keychain.remove(waveKeyName(p.id));
    setHaveKey(false);
    setEmail(null);
    setBusinesses(null);
  };

  const setWhose = (whose: Whose) => session.update((x) => ({ ...x, whose }));

  return (
    <div className="stack">
      <fieldset className="choice" style={{ border: "none", padding: 0, margin: 0 }}>
        <legend className="small muted" style={{ marginBottom: 6 }}>Whose books are these?</legend>
        {([
          ["mine", "Mine", "I sign in to Wave as the owner or an Admin."],
          ["client-access", "A client's, and I have access to their Wave", "I'm an Admin on their business (Wave's Pro plan), or use Wave Advisors."],
          ["client-no-access", "A client's, and I don't", "On Wave's free plan, clients can't give an accountant access. They can send the export files instead."],
        ] as const).map(([value, label, hint]) => (
          <label key={value}>
            <input type="radio" name={`whose-${p.id}`} checked={p.whose === value} onChange={() => void setWhose(value)} />
            <span><strong>{label}</strong><br /><span className="small muted">{hint}</span></span>
          </label>
        ))}
      </fieldset>

      {p.whose === "client-no-access" ? (
        <div className="banner">
          <p><strong>Without a Wave connection</strong>, everything still works from the export files your client sends. These are lost:</p>
          <ul className="plain small">{EXPORT_ONLY_LOSSES.map((l) => <li key={l}>{l}</li>)}</ul>
          <p className="small">Ask the client to send the transactions export (and the receipts export) from Wave's Data Export page. A ready-made request email and client app come in a later version.</p>
          <p className="small"><strong>Never ask a client to email their Wave access key.</strong> It opens their whole Wave account.</p>
          <label className="field" style={{ marginTop: 8 }}>
            <span>Currency of the books (nothing in the export says)</span>
            <select value={p.currency} onChange={(e) => void session.update((x) => ({ ...x, currency: e.target.value }))}>
              {["USD", "CAD", "GBP", "EUR", "AUD", "NZD"].map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
        </div>
      ) : null}

      {p.whose && p.whose !== "client-no-access" ? (
        p.wave && !businesses ? (
          <div className="banner green">
            <p><strong>✓ Connected to {p.wave.businessName}</strong>{p.wave.email ? ` as ${p.wave.email}` : ""}. Read from Wave on {formatDate(p.wave.fetchedAt)}.</p>
            <div className="row">
              <button className="button" disabled={!!busy || !haveKey} onClick={() => void pick({ id: p.wave!.businessId, name: p.wave!.businessName, currency: "", isPersonal: false, isArchived: false })}>Read from Wave again</button>
              <button className="button" disabled={!!busy || !haveKey} onClick={() => void loadBusinesses()}>Choose another business</button>
              {haveKey ? <button className="button" onClick={() => void forget()}>Forget this key</button> : null}
            </div>
            {!haveKey ? <p className="small">No Wave access key is stored for this project. To read from Wave again, paste one below.</p> : null}
          </div>
        ) : null
      ) : null}

      {p.whose && p.whose !== "client-no-access" && (!haveKey || (!p.wave && !businesses)) ? (
        <div className="stack">
          {!haveKey ? (
            <>
              <div className="row">
                <button className="button" onClick={() => void platform.openExternal(WAVE_KEY_PAGE)}>Open Wave's key page</button>
                <button className="button link" onClick={() => setShowGuide((s) => !s)}>{showGuide ? "Hide the steps" : "How do I get a Wave access key?"}</button>
              </div>
              {showGuide ? <Guide which="waveKey" /> : null}
              <form className="row" onSubmit={(e) => { e.preventDefault(); if (keyText.trim()) void checkKey(keyText); }}>
                <label className="field" style={{ flex: "1 1 320px" }}>
                  <span>Wave access key</span>
                  <input type="password" autoComplete="off" spellCheck={false} value={keyText} onChange={(e) => setKeyText(e.target.value)} placeholder="Paste the key from Wave" />
                </label>
                <button className="button primary" type="submit" disabled={!keyText.trim() || !!busy} style={{ alignSelf: "flex-end" }}>Check key</button>
              </form>
              <p className="small muted">"Connect to Wave" without a key is planned; Wave allows it only for businesses on its Pro plan or with Wave Advisors.</p>
            </>
          ) : (
            <div className="row">
              <button className="button primary" disabled={!!busy} onClick={() => void loadBusinesses()}>Choose the business</button>
              <button className="button" onClick={() => void forget()}>Forget this key</button>
            </div>
          )}
        </div>
      ) : null}

      {businesses ? (
        <div className="stack">
          <p><strong>✓ Key accepted</strong>{email ? ` for ${email}` : ""}. Which business are these books?</p>
          {businesses.length > 6 ? <input type="search" placeholder="Search businesses" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search businesses" /> : null}
          <div className="cards">
            {businesses.filter((b) => b.name.toLowerCase().includes(filter.toLowerCase())).map((b) => (
              <button key={b.id} className="card clickable" disabled={!!busy} onClick={() => void pick(b)}>
                <h3>{b.name}</h3>
                <p className="small muted">{[b.currency, b.isPersonal ? "personal" : null, b.isArchived ? "archived" : null].filter(Boolean).join(" · ")}</p>
              </button>
            ))}
          </div>
          {p.wave ? <button className="button" onClick={() => setBusinesses(null)}>Keep {p.wave.businessName}</button> : null}
        </div>
      ) : null}

      {busy ? <Progress text={busy} /> : null}
      {problem ? <ProblemBox problem={problem} onDismiss={() => setProblem(null)} /> : null}
    </div>
  );
}

export function Guide({ which }: { which: keyof typeof GUIDES }) {
  const g = GUIDES[which];
  return (
    <div className="guide">
      <h3>{g.title}</h3>
      <ol>{g.steps.map((s) => <li key={s}>{s}</li>)}</ol>
      <ul className="plain small muted" style={{ marginTop: 8 }}>{g.notes.map((n) => <li key={n}>{n}</li>)}</ul>
    </div>
  );
}
