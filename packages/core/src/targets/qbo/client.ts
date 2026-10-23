import { InputProblem } from "../../problems.ts";
import type { Fetch } from "../../readers/wave-api/client.ts";

/**
 * A small QuickBooks Online Accounting API client (developer.intuit.com, read
 * 2026-10-23): JSON over HTTPS to /v3/company/<realmId>/..., minorversion 75,
 * paced to Intuit's limits (10 requests a second and 500 a minute per company, 40
 * batch requests a minute), 429 answered by waiting 60 seconds, and every write
 * carrying a `requestid` so a retried request returns the first response instead of
 * creating a second copy.
 */

export type QboEnvironment = "sandbox" | "production";

export const QBO_BASE: Record<QboEnvironment, string> = {
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
  production: "https://quickbooks.api.intuit.com",
};

export const MINOR_VERSION = "75";

export interface QboCredentials {
  accessToken(): Promise<string>;
  /** After a 401: get a new access token. True if a retry may work. */
  refresh(): Promise<boolean>;
}

export interface QboFault {
  type: string;
  errors: { message: string; detail: string; code: string; element?: string }[];
}

export class QboError extends Error {
  readonly fault: QboFault;
  readonly status: number;
  constructor(status: number, fault: QboFault) {
    super(fault.errors.map((e) => `${e.code} ${e.message}: ${e.detail}`).join("; ") || `HTTP ${status}`);
    this.status = status;
    this.fault = fault;
  }
}

/** One item of a batch: create/update/delete an entity, with its own id for matching the response. */
export interface BatchItem {
  bId: string;
  operation: "create" | "update" | "delete";
  entity: string;
  body: Record<string, unknown>;
}

export interface BatchResult {
  bId: string;
  /** The created/updated entity, or the deleted one's {Id, status}. */
  entity?: Record<string, unknown>;
  fault?: QboFault;
}

export interface QboClientOptions {
  environment: QboEnvironment;
  realmId: string;
  credentials: QboCredentials;
  fetch?: Fetch;
  /** Override the base URL (tests). */
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxRetries?: number;
}

const faultOf = (json: unknown): QboFault | undefined => {
  const f = (json as { Fault?: { type?: string; Error?: { Message?: string; Detail?: string; code?: string; element?: string }[] } })?.Fault;
  if (!f) return undefined;
  return {
    type: f.type ?? "",
    errors: (f.Error ?? []).map((e) => ({ message: e.Message ?? "", detail: e.Detail ?? "", code: e.code ?? "", ...(e.element ? { element: e.element } : {}) })),
  };
};

export class QboClient {
  readonly environment: QboEnvironment;
  readonly realmId: string;
  private readonly opts: QboClientOptions;
  private readonly fetch: Fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly base: string;
  /** Request times in the last minute, for the 500/min and 10/s limits. */
  private recent: number[] = [];
  private recentBatches: number[] = [];
  requests = 0;

  constructor(opts: QboClientOptions) {
    this.opts = opts;
    this.environment = opts.environment;
    this.realmId = opts.realmId;
    this.fetch = opts.fetch ?? (globalThis.fetch as unknown as Fetch);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.base = `${opts.baseUrl ?? QBO_BASE[opts.environment]}/v3/company/${encodeURIComponent(opts.realmId)}`;
  }

  /** Read with Intuit's SQL-like query language. Reads are metered on Intuit's free tier: use sparingly. */
  async query<T = Record<string, unknown>>(entity: string, where = "", max = 1000): Promise<T[]> {
    const out: T[] = [];
    for (let start = 1; ; start += max) {
      const q = `select * from ${entity}${where ? ` where ${where}` : ""} startposition ${start} maxresults ${max}`;
      const r = (await this.call("GET", `/query?query=${encodeURIComponent(q)}`)) as { QueryResponse?: Record<string, T[]> };
      const rows = r.QueryResponse?.[entity] ?? [];
      out.push(...rows);
      if (rows.length < max) return out;
    }
  }

  async create(entity: string, body: Record<string, unknown>, requestId: string): Promise<Record<string, unknown>> {
    const r = (await this.call("POST", `/${entity.toLowerCase()}?requestid=${encodeURIComponent(requestId)}`, body)) as Record<string, Record<string, unknown>>;
    return r[entity]!;
  }

  async batch(items: BatchItem[], requestId: string): Promise<BatchResult[]> {
    if (items.length > 30) throw new Error("batch of more than 30");
    await this.paceBatch();
    const body = {
      BatchItemRequest: items.map((i) => ({ bId: i.bId, operation: i.operation, [i.entity]: i.body })),
    };
    const r = (await this.call("POST", `/batch?requestid=${encodeURIComponent(requestId)}`, body)) as {
      BatchItemResponse?: (Record<string, unknown> & { bId: string; Fault?: unknown })[];
    };
    return (r.BatchItemResponse ?? []).map((x) => {
      const fault = faultOf(x);
      if (fault) return { bId: x.bId, fault };
      const key = Object.keys(x).find((k) => k !== "bId" && k !== "Fault");
      return { bId: x.bId, ...(key ? { entity: x[key] as Record<string, unknown> } : {}) };
    });
  }

  async report(name: string, params: Record<string, string>): Promise<QboReport> {
    const q = new URLSearchParams(params).toString();
    return (await this.call("GET", `/reports/${name}?${q}`)) as QboReport;
  }

  async companyInfo(): Promise<{ CompanyName: string; Country?: string }> {
    const r = (await this.call("GET", `/companyinfo/${encodeURIComponent(this.realmId)}`)) as { CompanyInfo: { CompanyName: string; Country?: string } };
    return r.CompanyInfo;
  }

  async preferences(): Promise<Record<string, unknown>> {
    const r = (await this.call("GET", "/preferences")) as { Preferences: Record<string, unknown> };
    return r.Preferences;
  }

  private async pace(): Promise<void> {
    for (;;) {
      const t = this.now();
      this.recent = this.recent.filter((x) => t - x < 60_000);
      const lastSecond = this.recent.filter((x) => t - x < 1000).length;
      if (this.recent.length < 480 && lastSecond < 9) break;
      await this.sleep(lastSecond >= 9 ? 120 : 1000);
    }
    this.recent.push(this.now());
  }

  private async paceBatch(): Promise<void> {
    for (;;) {
      const t = this.now();
      this.recentBatches = this.recentBatches.filter((x) => t - x < 60_000);
      if (this.recentBatches.length < 38) break;
      await this.sleep(1500);
    }
    this.recentBatches.push(this.now());
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${this.base}${path}${sep}minorversion=${MINOR_VERSION}`;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      let res: Awaited<ReturnType<Fetch>>;
      try {
        res = await this.fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${await this.opts.credentials.accessToken()}`,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : (undefined as unknown as string),
        });
      } catch (e) {
        if (attempt < (this.opts.maxRetries ?? 4)) {
          await this.sleep(2000 * 2 ** attempt);
          continue;
        }
        throw new InputProblem("wave-unavailable", "Wave Exit couldn't reach QuickBooks. The computer may be offline, or QuickBooks may be down.", "Check the internet connection. Loading picks up where it stopped when you try again.", String(e));
      }
      this.requests++;
      if (res.status === 401 && !refreshed && (await this.opts.credentials.refresh())) {
        refreshed = true;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < (this.opts.maxRetries ?? 4)) {
        // Intuit: on 429 wait 60 seconds before retrying.
        await this.sleep(res.status === 429 ? 60_000 : 2000 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        throw new QboError(res.status, { type: "Unreadable", errors: [{ message: "Unreadable response", detail: text.slice(0, 500), code: String(res.status) }] });
      }
      const fault = faultOf(json);
      if (res.status >= 400 || fault) throw new QboError(res.status, fault ?? { type: "HTTP", errors: [{ message: `HTTP ${res.status}`, detail: text.slice(0, 500), code: String(res.status) }] });
      return json;
    }
  }
}

export interface QboReport {
  Header?: Record<string, unknown>;
  Columns?: { Column?: { ColTitle?: string; ColType?: string }[] };
  Rows?: { Row?: QboReportRow[] };
}

export interface QboReportRow {
  type?: string;
  group?: string;
  ColData?: { value?: string; id?: string }[];
  Header?: { ColData?: { value?: string; id?: string }[] };
  Rows?: { Row?: QboReportRow[] };
  Summary?: { ColData?: { value?: string; id?: string }[] };
}

/** Turn a QuickBooks fault into words for an accountant, with the original kept for support. */
export function explainQboError(e: unknown): { explanation: string; nextStep: string; detail: string } {
  if (e instanceof QboError) {
    const first = e.fault.errors[0];
    const detail = e.message;
    if (e.status === 401 || e.fault.type === "AUTHENTICATION") {
      return { explanation: "QuickBooks no longer accepts this connection.", nextStep: "Connect to QuickBooks again. Loading picks up where it stopped.", detail };
    }
    if (e.status === 403) {
      return { explanation: "QuickBooks refused: the person who connected may not have permission to add transactions to this company.", nextStep: "Connect with a QuickBooks login that is an admin of the company.", detail };
    }
    if (/Duplicate Name/i.test(first?.message ?? "")) {
      return { explanation: `QuickBooks already has something with the same name${first?.detail ? ` (${first.detail})` : ""}.`, nextStep: "Match it to the existing one on the account and contact mapping screen, or rename it in QuickBooks, then continue.", detail };
    }
    if (/stale|SyncToken/i.test(`${first?.message} ${first?.detail}`)) {
      return { explanation: "This record was changed in QuickBooks after Wave Exit created it, so Wave Exit won't remove it.", nextStep: "Delete it in QuickBooks yourself if you want it gone.", detail };
    }
    return { explanation: `QuickBooks refused a record: ${first?.message || "unknown reason"}.`, nextStep: "Copy the details for support. Everything before this point is loaded; fixing the cause and continuing won't create duplicates.", detail };
  }
  if (e instanceof InputProblem) return { explanation: e.explanation, nextStep: e.nextStep, detail: e.detail ?? "" };
  return { explanation: "Something went wrong while talking to QuickBooks.", nextStep: "Try again. Loading picks up where it stopped.", detail: String(e) };
}
