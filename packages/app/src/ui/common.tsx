import { formatDisplay, type Minor, type Severity } from "@wave-exit/core";
import { useState, type ReactNode } from "react";
import type { Problem } from "../engine/protocol.ts";
import { HelpLink } from "../help/HelpPanel.tsx";

/** Money for people: thousands separators, negatives in parentheses, business currency. */
export function Money({ value, exponent = 2, currency }: { value: Minor; exponent?: number; currency?: string }) {
  return (
    <span style={{ fontVariantNumeric: "tabular-nums" }}>
      {formatDisplay(value, exponent)}
      {currency ? <span className="sr-only"> {currency}</span> : null}
    </span>
  );
}

const WORD: Record<Severity | "skipped", string> = { green: "OK", amber: "Review", red: "Needs answer", skipped: "Skipped" };

export function StatusBadge({ status, children }: { status: Severity | "skipped"; children?: ReactNode }) {
  const cls = status === "skipped" ? "" : status;
  const icon = status === "green" ? "✓" : status === "amber" ? "!" : status === "red" ? "✕" : "–";
  return (
    <span className={`badge ${cls}`}>
      <span aria-hidden="true">{icon}</span> {children ?? WORD[status]}
    </span>
  );
}

/** What went wrong, why, and the one thing to do, with technical detail behind a button. */
export function ProblemBox({ problem, onDismiss }: { problem: Problem; onDismiss?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="banner red" role="alert">
      <p><strong>{problem.explanation}</strong></p>
      <p>{problem.nextStep}</p>
      <div className="row">
        {problem.detail ? (
          <button
            className="button"
            onClick={async () => {
              await navigator.clipboard?.writeText(`Wave Exit problem: ${problem.code}\n${problem.explanation}\n\n${problem.detail}`);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy details for support"}
          </button>
        ) : null}
        {onDismiss ? <button className="button" onClick={onDismiss}>Dismiss</button> : null}
        <HelpLink to="troubleshooting">Common messages</HelpLink>
      </div>
    </div>
  );
}

export function Progress({ text }: { text: string }) {
  return (
    <div className="progress card" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
