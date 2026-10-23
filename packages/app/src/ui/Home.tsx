import { useEffect, useState } from "react";
import { useServices } from "../app/context.tsx";
import { newProject, type Project } from "../store/projects.ts";
import { Dialog, formatDate, plural, StatusBadge } from "./common.tsx";

/** Home: one project per client business, with where each one stands. */

export function projectStatus(p: Project): { text: string; tone: "green" | "amber" | "red" | "skipped" } {
  if (!p.inputs.transactions) return { text: p.whose === "client-no-access" ? "Waiting for the client's files" : "Waiting for the transactions export", tone: "skipped" };
  if (!p.status) return { text: "Not checked yet", tone: "skipped" };
  if (p.status.red) return { text: `Needs review: ${plural(p.status.red, "item")} to answer`, tone: "red" };
  const last = p.outputs[0];
  if (last) return { text: `Outputs made ${formatDate(last.at)}`, tone: "green" };
  return { text: p.status.amber ? `Ready for outputs (${plural(p.status.amber, "note")} to look at)` : "Ready for outputs", tone: p.status.amber ? "amber" : "green" };
}

export function Home({ open, onSample }: { open: (id: string) => void; onSample: () => Promise<string> }) {
  const { store } = useServices();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<Project | null>(null);

  const reload = () => void store.list().then(setProjects);
  useEffect(reload, [store]);

  return (
    <div className="page stack">
      <div className="spread">
        <div>
          <h1>Your clients</h1>
          <p className="muted">One project per Wave business. Each keeps its own files, answers and outputs.</p>
        </div>
        <div className="row">
          <button className="button" onClick={async () => open(await onSample())}>Try a sample business</button>
          <button className="button primary" onClick={() => setCreating(true)}>New project</button>
        </div>
      </div>

      <div className="banner small">
        <strong>Your clients' books stay on this computer.</strong> Wave Exit reads from Wave and writes only to the places you choose.
        Nothing is sent to Wave Exit or anyone else, and projects are stored encrypted.
      </div>

      {projects === null ? null : projects.length === 0 ? (
        <div className="card">
          <h2>No projects yet</h2>
          <p>Start a project for a client business, or try the sample business to see how it works.</p>
        </div>
      ) : (
        <div className="cards">
          {projects.map((p) => {
            const s = projectStatus(p);
            return (
              <div key={p.id} className="card stack">
                <button className="card clickable" style={{ border: "none", padding: 0 }} onClick={() => open(p.id)} aria-label={`Open ${p.clientName}`}>
                  <h2>{p.clientName}</h2>
                  <p className="small muted">
                    {[p.inputs.transactions ? "Transactions export" : null, p.wave ? "Wave connection" : null, p.inputs.receipts ? "Receipts" : null].filter(Boolean).join(" · ") || "No files yet"}
                  </p>
                  {p.status?.entries ? <p className="small muted">{plural(p.status.entries, "transaction")}, {formatDate(p.status.firstDate)} – {formatDate(p.status.lastDate)}</p> : null}
                  <StatusBadge status={s.tone}>{s.text}</StatusBadge>
                </button>
                <div className="row">
                  <button className="button link small" onClick={() => setDeleting(p)}>Delete project</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {creating ? (
        <Dialog title="New project" onClose={() => setCreating(false)}>
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!name.trim()) return;
              const p = await store.save(newProject(name));
              setCreating(false);
              setName("");
              open(p.id);
            }}
          >
            <label className="field">
              <span>Client business name, as it appears in Wave</span>
              <input type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Maple & Pine Design LLC" />
            </label>
            <div className="row">
              <button className="button primary" type="submit" disabled={!name.trim()}>Create project</button>
              <button className="button" type="button" onClick={() => setCreating(false)}>Cancel</button>
            </div>
          </form>
        </Dialog>
      ) : null}

      {deleting ? (
        <Dialog title={`Delete ${deleting.clientName}?`} onClose={() => setDeleting(null)}>
          <p>This removes the project's files, answers and stored Wave access key from this computer. Outputs you've saved elsewhere are kept. Wave isn't affected.</p>
          <div className="row">
            <button className="button danger" onClick={async () => { await store.remove(deleting.id); setDeleting(null); reload(); }}>Delete project</button>
            <button className="button" onClick={() => setDeleting(null)}>Keep it</button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
