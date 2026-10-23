import type { QboClient, BatchItem } from "./client.ts";
import { explainQboError } from "./client.ts";
import type { LoadOp, LoadPlan, QboEntity } from "./plan.ts";

/**
 * Running and undoing a load. The load record (kept in the project) holds every
 * QuickBooks ID Wave Exit created, against the plan key it came from, and is saved
 * after every batch. A rerun or a resume skips what the record already has, so
 * nothing is created twice. A batch that was sent but not recorded (the app was
 * closed mid-request) is sent again with the same request ID, and QuickBooks
 * answers with the first response instead of creating copies. The request ID
 * depends only on the batch's contents and the record's generation, which goes up
 * after an undo so a later reload never collides with old requests.
 */

export const LOAD_RECORD_FORMAT = "wave-exit/qbo-load@1";

export interface CreatedRecord {
  key: string;
  entity: QboEntity;
  id: string;
  syncToken: string;
  label: string;
}

export interface FailedRecord {
  key: string;
  label: string;
  explanation: string;
  nextStep: string;
  detail: string;
}

export interface LoadRecord {
  format: typeof LOAD_RECORD_FORMAT;
  environment: "sandbox" | "production";
  realmId: string;
  companyName: string;
  generation: number;
  status: "not-started" | "running" | "paused" | "failed" | "finished" | "undoing" | "undone";
  created: CreatedRecord[];
  failed: FailedRecord[];
  updatedAt: string;
}

export function newLoadRecord(environment: LoadRecord["environment"], realmId: string, companyName: string): LoadRecord {
  return { format: LOAD_RECORD_FORMAT, environment, realmId, companyName, generation: 1, status: "not-started", created: [], failed: [], updatedAt: "" };
}

export interface RunOptions {
  /** Save the record (called after every batch). */
  save: (r: LoadRecord) => Promise<void> | void;
  onProgress?: (p: { done: number; total: number; phase: string; label: string }) => void;
  signal?: AbortSignal;
  now?: () => Date;
}

const LIST_ENTITIES = new Set<QboEntity>(["Account", "Customer", "Vendor", "Item"]);

async function requestId(parts: string[]): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\n")));
  return `we${[...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("")}`; // 34 characters (batch limit 36)
}

/** Intuit: invoices and payments in batches of 10, in date order; everything else up to 30. */
const batchSize = (phase: number) => (phase === 3 || phase === 4 ? 10 : 30);

export async function runLoad(plan: LoadPlan, client: QboClient, record: LoadRecord, opts: RunOptions): Promise<LoadRecord> {
  if (record.realmId !== client.realmId || record.environment !== client.environment) throw new Error("load record is for another company");
  const now = () => (opts.now?.() ?? new Date()).toISOString();
  const ids = new Map<string, string>(plan.existing);
  for (const c of record.created) ids.set(c.key, c.id);
  const idOf = (key: string) => {
    const v = ids.get(key);
    if (!v) throw new MissingDependency(key);
    return v;
  };
  const total = plan.ops.length;
  const save = async (status: LoadRecord["status"]) => {
    record.status = status;
    record.updatedAt = now();
    await opts.save(record);
  };
  record.failed = [];
  await save("running");

  const phases = [...new Set(plan.ops.map((o) => o.phase))].sort((a, b) => a - b);
  for (const phase of phases) {
    const pending = plan.ops.filter((o) => o.phase === phase && !ids.has(o.key));
    for (let i = 0; i < pending.length; i += batchSize(phase)) {
      if (opts.signal?.aborted) {
        await save("paused");
        return record;
      }
      const chunk = pending.slice(i, i + batchSize(phase));
      const items: (BatchItem & { op: LoadOp })[] = [];
      for (const [k, op] of chunk.entries()) {
        try {
          items.push({ bId: String(k), operation: "create", entity: op.entity, body: op.build(idOf), op });
        } catch (e) {
          if (!(e instanceof MissingDependency)) throw e;
          const dep = plan.ops.find((o) => o.key === e.key);
          record.failed.push({ key: op.key, label: op.label, explanation: `Waiting for “${dep?.label ?? e.key}”, which wasn't created.`, nextStep: "Fix the first problem in the list, then continue.", detail: e.key });
        }
      }
      if (items.length) {
        let results;
        try {
          results = await client.batch(items, await requestId([String(record.generation), ...items.map((x) => x.op.key)]));
        } catch (e) {
          const why = explainQboError(e);
          for (const x of items) record.failed.push({ key: x.op.key, label: x.op.label, ...why });
          await save("failed");
          return record;
        }
        for (const r of results) {
          const x = items[Number(r.bId)];
          if (!x) continue;
          if (r.entity && typeof r.entity.Id === "string") {
            ids.set(x.op.key, r.entity.Id);
            record.created.push({ key: x.op.key, entity: x.op.entity, id: r.entity.Id, syncToken: String(r.entity.SyncToken ?? "0"), label: x.op.label });
          } else {
            const f = r.fault;
            const msg = f?.errors[0];
            record.failed.push({
              key: x.op.key, label: x.op.label,
              explanation: `QuickBooks refused ${x.op.label}: ${msg?.message ?? "no reason given"}.`,
              nextStep: "Fix the cause (often a name clash or a closed period), then continue. Nothing already loaded is repeated.",
              detail: JSON.stringify(f ?? r).slice(0, 2000),
            });
          }
        }
      }
      await save("running");
      opts.onProgress?.({ done: record.created.filter((c) => plan.ops.some((o) => o.key === c.key)).length, total, phase: String(phase), label: chunk.at(-1)!.label });
    }
    // Later phases refer to this one's records: stop at the first phase with problems.
    if (record.failed.length) {
      await save("failed");
      return record;
    }
  }
  await save("finished");
  return record;
}

class MissingDependency extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`missing ${key}`);
    this.key = key;
  }
}

/**
 * "Remove everything Wave Exit loaded": delete the recorded transactions, newest
 * first, then make the recorded accounts, contacts and items inactive (QuickBooks
 * doesn't allow deleting those). Records QuickBooks refuses (usually because they
 * were changed there since) are listed, not forced.
 */
export async function undoLoad(client: QboClient, record: LoadRecord, opts: RunOptions): Promise<LoadRecord> {
  if (record.realmId !== client.realmId || record.environment !== client.environment) throw new Error("load record is for another company");
  const now = () => (opts.now?.() ?? new Date()).toISOString();
  const save = async (status: LoadRecord["status"]) => {
    record.status = status;
    record.updatedAt = now();
    await opts.save(record);
  };
  record.failed = [];
  await save("undoing");
  const total = record.created.length;
  const order = [...record.created].reverse();
  const txns = order.filter((c) => !LIST_ENTITIES.has(c.entity));
  const lists = order.filter((c) => LIST_ENTITIES.has(c.entity));
  let done = 0;
  for (const group of [txns, lists]) {
    for (let i = 0; i < group.length; i += 30) {
      if (opts.signal?.aborted) {
        await save("paused");
        return record;
      }
      const chunk = group.slice(i, i + 30);
      const items: BatchItem[] = chunk.map((c, k) =>
        LIST_ENTITIES.has(c.entity)
          ? { bId: String(k), operation: "update", entity: c.entity, body: { Id: c.id, SyncToken: c.syncToken, sparse: true, Active: false } }
          : { bId: String(k), operation: "delete", entity: c.entity, body: { Id: c.id, SyncToken: c.syncToken } },
      );
      let results;
      try {
        results = await client.batch(items, await requestId(["undo", String(record.generation), ...chunk.map((c) => c.key)]));
      } catch (e) {
        const why = explainQboError(e);
        for (const c of chunk) record.failed.push({ key: c.key, label: c.label, ...why });
        await save("failed");
        return record;
      }
      const gone = new Set<string>();
      for (const r of results) {
        const c = chunk[Number(r.bId)];
        if (!c) continue;
        if (r.fault) {
          const why = r.fault.errors[0];
          record.failed.push({
            key: c.key, label: c.label,
            explanation: /stale|synctoken/i.test(`${why?.message} ${why?.detail}`)
              ? `${c.label} was changed in QuickBooks after Wave Exit created it, so it was left alone.`
              : `QuickBooks wouldn't remove ${c.label}: ${why?.message ?? "no reason given"}.`,
            nextStep: "Remove it in QuickBooks yourself if you want it gone.",
            detail: JSON.stringify(r.fault).slice(0, 2000),
          });
        } else gone.add(c.key);
      }
      record.created = record.created.filter((c) => !gone.has(c.key));
      done += chunk.length;
      await save("undoing");
      opts.onProgress?.({ done, total, phase: "undo", label: chunk.at(-1)!.label });
    }
  }
  // New request IDs from here on, so loading again never replays old requests.
  record.generation += 1;
  await save(record.failed.length ? "failed" : "undone");
  return record;
}
