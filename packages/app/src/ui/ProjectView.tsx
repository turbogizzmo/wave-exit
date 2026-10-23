import { expandZips, looksLikeReceiptsExport, looksLikeTransactionsExport, type InputFile } from "@wave-exit/core";
import { useEffect, useState } from "react";
import { useServices } from "../app/context.tsx";
import { useSession, type Session } from "../app/session.ts";
import type { Problem } from "../engine/protocol.ts";
import type { SlotId } from "../store/projects.ts";
import { plural, ProblemBox, Progress } from "./common.tsx";
import { InputsScreen } from "./InputsScreen.tsx";
import { OutputsScreen } from "./OutputsScreen.tsx";
import { ReviewScreen } from "./ReviewScreen.tsx";

export type Tab = "inputs" | "review" | "outputs";

/** Work out which slot dropped files belong to, or say plainly why none. */
export function routeFiles(files: InputFile[]): { slot: SlotId } | { problem: Problem } {
  const names = files.map((f) => f.path.toLowerCase());
  if (names.some((n) => n.endsWith(".waveexit"))) {
    return { problem: { code: "not-yet", explanation: "This is a client collection file. Opening collection files comes in a later version of Wave Exit.", nextStep: "Ask the client for Wave's transactions and receipts exports for now." } };
  }
  try {
    if (looksLikeTransactionsExport(files)) return { slot: "transactions" };
    if (looksLikeReceiptsExport(files)) return { slot: "receipts" };
    expandZips(files);
  } catch (e) {
    const p = e as { code?: string; explanation?: string; nextStep?: string; detail?: string };
    if (p.explanation) return { problem: { code: p.code ?? "damaged-file", explanation: p.explanation, nextStep: p.nextStep ?? "", ...(p.detail ? { detail: p.detail } : {}) } };
  }
  return {
    problem: {
      code: "not-a-wave-export",
      explanation: `${files.length === 1 ? `"${files[0]!.path.split("/").pop()}" doesn't` : "These files don't"} look like a Wave export: there is no accounting.csv (transactions export) and the names don't follow Wave's receipt naming.`,
      nextStep: "Use the ZIP file from Wave's Data Export email, or the folder it unzips to.",
      detail: files.slice(0, 20).map((f) => f.path).join("\n"),
    },
  };
}

export function ProjectView({ id, tab, setTab, back }: { id: string; tab: Tab; setTab: (t: Tab) => void; back: () => void }) {
  const { platform } = useServices();
  const s = useSession(id);
  const [hover, setHover] = useState(false);
  const [dropProblem, setDropProblem] = useState<Problem | null>(null);
  const session = "project" in s ? s : null;

  const accept = async (files: InputFile[], slot?: SlotId) => {
    if (!session) return;
    setDropProblem(null);
    const route = slot ? { slot } : routeFiles(files);
    if ("problem" in route) return setDropProblem(route.problem);
    setTab("inputs");
    await session.addInput(route.slot, files);
  };

  useEffect(() => platform.onFilesDropped((files) => void accept(files), setHover));

  if ("loading" in s) return <div className="page"><Progress text="Opening the project…" /></div>;
  if ("missing" in s) return <div className="page"><p>This project can't be opened.</p><button className="button" onClick={back}>Back to projects</button></div>;
  const ses = s as Session;
  const reviewBadge = ses.result ? (ses.blocked ? <span className="badge red">{ses.blocked}</span> : <span className="badge green">✓</span>) : null;

  return (
    <div className="page">
      <button className="button link small" onClick={back}>← All projects</button>
      <h1 style={{ marginTop: 8 }}>{ses.project.clientName}</h1>
      <div className="tabs" role="tablist" aria-label="Project steps">
        <button className="tab" role="tab" aria-selected={tab === "inputs"} onClick={() => setTab("inputs")}>1. Inputs</button>
        <button className="tab" role="tab" aria-selected={tab === "review"} disabled={!ses.project.inputs.transactions} onClick={() => setTab("review")}>2. Review {reviewBadge}</button>
        <button className="tab" role="tab" aria-selected={tab === "outputs"} disabled={!ses.result} title={ses.blocked ? `${plural(ses.blocked, "item")} to answer on Review first` : undefined} onClick={() => setTab("outputs")}>3. Outputs</button>
      </div>
      {dropProblem ? <div style={{ marginBottom: 16 }}><ProblemBox problem={dropProblem} onDismiss={() => setDropProblem(null)} /></div> : null}
      {ses.building && tab === "inputs" ? <div style={{ marginBottom: 16 }}><Progress text={ses.building} /></div> : null}
      <div role="tabpanel">
        {tab === "inputs" ? <InputsScreen session={ses} onPick={async (slot, folder) => { const f = await platform.pickInputFiles({ folder: !!folder }); if (f) await accept(f, slot); }} /> : null}
        {tab === "review" ? <ReviewScreen session={ses} /> : null}
        {tab === "outputs" ? <OutputsScreen session={ses} goReview={() => setTab("review")} /> : null}
      </div>
      {hover ? <div className="dropzone">Drop Wave's files to add them</div> : null}
    </div>
  );
}
