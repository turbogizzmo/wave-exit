import type { BuildRequest, BuildResult, OutputsRequest, OutputsResult, Problem, Request, Response } from "./protocol.ts";
import type { Issue } from "@wave-exit/core";

/** Promise-style access to the books worker, with progress callbacks. */
export class EngineError extends Error {
  readonly problem: Problem;
  readonly slot: string | undefined;
  constructor(problem: Problem, slot?: string) {
    super(problem.explanation);
    this.problem = problem;
    this.slot = slot;
  }
}

type Omit2<T> = T extends unknown ? Omit<T, "id" | "type"> : never;

export class Engine {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; progress?: (s: string) => void }>();

  constructor(worker?: Worker) {
    this.worker = worker ?? new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev: MessageEvent<Response>) => {
      const m = ev.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === "progress") p.progress?.(m.step);
      else {
        this.pending.delete(m.id);
        if (m.type === "done") p.resolve(m.result);
        else p.reject(new EngineError(m.problem, m.slot));
      }
    };
  }

  private send<T>(type: Request["type"], body: object, progress?: (s: string) => void): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, ...(progress ? { progress } : {}) });
      this.worker.postMessage({ ...body, type, id } as Request);
    });
  }

  build(req: Omit2<BuildRequest>, progress?: (s: string) => void) {
    return this.send<BuildResult>("build", req, progress);
  }

  outputs(req: Omit2<OutputsRequest>, progress?: (s: string) => void) {
    return this.send<OutputsResult>("outputs", req, progress);
  }

  validate() {
    return this.send<Record<string, Issue[]>>("validate", {});
  }
}
