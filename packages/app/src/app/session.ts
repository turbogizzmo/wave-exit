import { blockingItems, type InputFile, type Settings, type WaveSnapshot } from "@wave-exit/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { EngineError } from "../engine/client.ts";
import type { BuildResult, Problem } from "../engine/protocol.ts";
import type { Project, SlotId } from "../store/projects.ts";
import { useServices } from "./context.tsx";

/**
 * One open project: its saved state, the books built from its inputs, and the
 * per-slot problems. Review re-runs automatically whenever inputs or settings change.
 */
export interface Session {
  project: Project;
  result: BuildResult | null;
  building: string | null;
  problems: Partial<Record<SlotId | "wave" | "build", Problem>>;
  addInput(slot: SlotId, files: InputFile[]): Promise<void>;
  removeInput(slot: SlotId): Promise<void>;
  setWave(snapshot: WaveSnapshot, email: string): Promise<void>;
  clearWave(): Promise<void>;
  update(change: (p: Project) => Project): Promise<void>;
  setSettings(change: (s: Settings) => Settings): Promise<void>;
  clearProblem(slot: SlotId | "wave" | "build"): void;
  blocked: number;
}

export function useSession(projectId: string): Session | { loading: true } | { missing: true } {
  const { store, engine, today } = useServices();
  const [project, setProject] = useState<Project | null | undefined>(undefined);
  const [result, setResult] = useState<BuildResult | null>(null);
  const [building, setBuilding] = useState<string | null>(null);
  const [problems, setProblems] = useState<Session["problems"]>({});
  const run = useRef(0);

  useEffect(() => {
    void store.load(projectId).then(setProject, () => setProject(null));
  }, [store, projectId]);

  const rebuild = useCallback(async (p: Project) => {
    const mine = ++run.current;
    if (!p.inputs.transactions) {
      setResult(null);
      return p;
    }
    setBuilding("Getting ready…");
    try {
      const transactions = await store.readInput(p, p.inputs.transactions.blob);
      const receipts = p.inputs.receipts ? await store.readInput(p, p.inputs.receipts.blob) : undefined;
      const snapshot = p.wave ? await store.readSnapshot(p, p.wave.blob) : undefined;
      const r = await engine.build(
        { transactions, ...(receipts ? { receipts } : {}), ...(snapshot ? { snapshot } : {}), settings: p.settings, business: { name: p.clientName, currency: p.currency }, today: today() },
        (step) => mine === run.current && setBuilding(step),
      );
      if (mine !== run.current) return p;
      setResult(r);
      setProblems((x) => ({ ...x, build: undefined, transactions: undefined, receipts: undefined }));
      const b = blockingItems(r.books);
      const status = {
        red: b.issues.length + b.checks.length,
        amber: r.books.issues.filter((i) => i.severity === "amber" && !i.resolution).length + r.books.checks.filter((c) => c.status === "amber").length,
        at: new Date().toISOString(), entries: r.books.entries.length, firstDate: r.books.period.firstDate, lastDate: r.books.period.lastDate,
      };
      const next = await store.save({ ...p, status });
      setProject(next);
      return next;
    } catch (e) {
      if (mine !== run.current) return p;
      const slot = (e instanceof EngineError && (e.slot === "receipts" || e.slot === "transactions" || e.slot === "wave") ? e.slot : "build") as SlotId | "wave" | "build";
      setProblems((x) => ({ ...x, [slot]: e instanceof EngineError ? e.problem : { code: "unexpected", explanation: "The books couldn't be read.", nextStep: "Try again.", detail: String(e) } }));
      setResult(null);
      return p;
    } finally {
      if (mine === run.current) setBuilding(null);
    }
  }, [engine, store, today]);

  const loaded = useRef<string | null>(null);
  useEffect(() => {
    if (project && loaded.current !== project.id) {
      loaded.current = project.id;
      void rebuild(project);
    }
  }, [project, rebuild]);

  if (project === undefined) return { loading: true };
  if (project === null) return { missing: true };

  const save = async (next: Project, rebuildAfter = true) => {
    const saved = await store.save(next);
    setProject(saved);
    if (rebuildAfter) await rebuild(saved);
  };

  return {
    project, result, building, problems,
    blocked: result ? blockingItems(result.books).issues.length + blockingItems(result.books).checks.length : 0,
    async addInput(slot, files) {
      const stored = await store.storeInput(project, files);
      const old = project.inputs[slot];
      const history = old ? [{ slot, fileName: old.fileName, addedAt: old.addedAt, summary: old.summary }, ...project.history] : project.history;
      setProblems((x) => ({ ...x, [slot]: undefined }));
      await save({ ...project, history, inputs: { ...project.inputs, [slot]: { ...stored, addedAt: new Date().toISOString(), summary: "" } } });
    },
    async removeInput(slot) {
      const { [slot]: _gone, ...rest } = project.inputs;
      await save({ ...project, inputs: rest });
    },
    async setWave(snapshot, email) {
      const blob = await store.storeSnapshot(project, snapshot);
      const history = project.wave ? [{ slot: "wave" as const, fileName: project.wave.businessName, addedAt: project.wave.fetchedAt, summary: "" }, ...project.history] : project.history;
      await save({
        ...project, history,
        wave: { blob, businessId: snapshot.business.id, businessName: snapshot.business.name, email, fetchedAt: snapshot.fetchedAt, kind: snapshot.connection },
        currency: snapshot.business.currency.code || project.currency,
      });
    },
    async clearWave() {
      await save({ ...project, wave: null });
    },
    async update(change) {
      await save(change(project), false);
    },
    async setSettings(change) {
      await save({ ...project, settings: change(project.settings) });
    },
    clearProblem(slot) {
      setProblems((x) => ({ ...x, [slot]: undefined }));
    },
  };
}
