import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { HELP, topic, type Block } from "./content.ts";

/**
 * Help, available everywhere: the Help button in the top bar opens the topic list,
 * and "?" links next to slots, checks and outputs open the topic that explains them.
 * It slides over the screen, so the project underneath keeps its place.
 */

const HelpContext = createContext<(id?: string) => void>(() => {});
export const useHelp = () => useContext(HelpContext);

export function HelpLink({ to, children = "What's this?" }: { to: string; children?: ReactNode }) {
  const open = useHelp();
  return (
    <button className="button link small help-link" onClick={() => open(to)}>
      <span aria-hidden="true">?</span> {children}
    </button>
  );
}

export function BlockView({ b }: { b: Block }) {
  if ("p" in b) return <p>{b.p}</p>;
  if ("note" in b) return <div className="banner small">{b.note}</div>;
  if ("steps" in b) return <ol>{b.steps.map((s) => <li key={s}>{s}</li>)}</ol>;
  if ("list" in b) return <ul>{b.list.map((s) => <li key={s}>{s}</li>)}</ul>;
  return (
    <div className="scroll-x">
      <table className="data">
        <thead><tr>{b.table.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{b.table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function HelpProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ open: boolean; id?: string }>({ open: false });
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const open = (id?: string) => setState({ open: true, ...(id ? { id } : {}) });

  useEffect(() => {
    if (state.open) {
      closeRef.current?.focus();
      bodyRef.current?.scrollTo?.(0, 0);
    }
  }, [state]);

  const current = state.id ? topic(state.id) : undefined;
  return (
    <HelpContext.Provider value={open}>
      {children}
      {state.open ? (
        <div className="help-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setState({ open: false })} onKeyDown={(e) => e.key === "Escape" && setState({ open: false })}>
          <aside className="help-panel" role="dialog" aria-modal="true" aria-label="Help">
            <div className="spread help-head">
              <div className="row">
                {current ? <button className="button link small" onClick={() => setState({ open: true })}>← All help</button> : null}
                <strong>Help</strong>
              </div>
              <button ref={closeRef} className="button" onClick={() => setState({ open: false })}>Close</button>
            </div>
            <div className="help-body" ref={bodyRef}>
              {current ? (
                <article className="stack help-article">
                  <h2>{current.title}</h2>
                  {current.blocks.map((b, i) => <BlockView key={i} b={b} />)}
                </article>
              ) : (
                <div className="stack">
                  {HELP.map((s) => (
                    <section key={s.title}>
                      <div className="group-title">{s.title}</div>
                      <ul className="help-topics">
                        {s.topics.map((t) => (
                          <li key={t.id}>
                            <button className="help-topic" onClick={() => setState({ open: true, id: t.id })}>
                              <strong>{t.title}</strong>
                              <span className="small muted">{t.summary}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
            </div>
          </aside>
        </div>
      ) : null}
    </HelpContext.Provider>
  );
}
