import { InputProblem } from "../../problems.ts";
import type { WaveCredentials } from "./auth.ts";

export const WAVE_API_URL = "https://gql.waveapps.com/graphql/public";

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface WaveClientOptions {
  credentials: WaveCredentials;
  fetch?: Fetch;
  url?: string;
  /** Minimum gap between requests. Wave publishes no limit; ~2 req/s stays clear of reported 429s. */
  minIntervalMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface GraphQLError {
  message: string;
  path?: (string | number)[];
  extensions?: { code?: string };
}

/**
 * A read-only GraphQL client for Wave's public API. Refuses mutations by
 * construction, throttles, retries 429/5xx with exponential backoff, refreshes
 * OAuth tokens once on 401, and turns every failure into a plain-English problem.
 */
export class WaveClient {
  private readonly fetch: Fetch;
  private readonly url: string;
  private readonly minInterval: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly opts: WaveClientOptions;
  private last = Number.NEGATIVE_INFINITY;
  requests = 0;

  constructor(opts: WaveClientOptions) {
    this.opts = opts;
    this.fetch = opts.fetch ?? (globalThis.fetch as unknown as Fetch);
    this.url = opts.url ?? WAVE_API_URL;
    this.minInterval = opts.minIntervalMs ?? 500;
    this.maxRetries = opts.maxRetries ?? 5;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  get credentialKind() {
    return this.opts.credentials.kind;
  }

  async query<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (/\bmutation\b/i.test(document.replace(/#.*$/gm, ""))) {
      throw new Error("WaveClient is read-only: mutations are not allowed");
    }
    const body = JSON.stringify({ query: document, variables });
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      let res: Awaited<ReturnType<Fetch>>;
      try {
        res = await this.fetch(this.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${await this.opts.credentials.accessToken()}`,
            "Content-Type": "application/json",
          },
          body,
        });
      } catch (e) {
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw new InputProblem(
          "wave-unavailable",
          "Wave Exit couldn't reach Wave. The computer may be offline, or Wave may be down.",
          "Check the internet connection and try again in a few minutes.",
          String(e),
        );
      }
      this.requests++;

      if (res.status === 401 || res.status === 403) {
        if (!refreshed && (await this.opts.credentials.refresh())) {
          refreshed = true;
          continue;
        }
        throw this.authProblem(res.status, await safeText(res));
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt < this.maxRetries) {
          const retryAfter = Number(res.headers.get("retry-after"));
          await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.backoff(attempt));
          continue;
        }
        throw res.status === 429
          ? new InputProblem("wave-busy", "Wave is limiting how fast Wave Exit can read, and kept refusing after several tries.", "Wait a few minutes, then try again.")
          : new InputProblem("wave-unavailable", "Wave's servers are having trouble right now.", "Try again in a few minutes.", `HTTP ${res.status}`);
      }

      const text = await res.text();
      let json: { data?: T; errors?: GraphQLError[] };
      try {
        json = JSON.parse(text);
      } catch {
        throw new InputProblem("wave-unexpected", "Wave sent back something Wave Exit didn't understand.", "Try again. If it keeps happening, copy the details for support.", `HTTP ${res.status}: ${text.slice(0, 500)}`);
      }
      if (json.errors?.length) {
        const codes = json.errors.map((e) => e.extensions?.code ?? "");
        if (codes.includes("UNAUTHENTICATED")) {
          if (!refreshed && (await this.opts.credentials.refresh())) {
            refreshed = true;
            continue;
          }
          throw this.authProblem(401, text);
        }
        if (codes.includes("FORBIDDEN")) throw this.authProblem(403, text);
        throw new InputProblem(
          "wave-unexpected",
          "Wave reported an error while Wave Exit was reading the books.",
          "Try again. If it keeps happening, copy the details for support.",
          JSON.stringify(json.errors).slice(0, 2000),
        );
      }
      if (json.data === undefined) {
        throw new InputProblem("wave-unexpected", "Wave sent back an empty answer.", "Try again.", text.slice(0, 500));
      }
      return json.data;
    }
  }

  private authProblem(status: number, detail: string): InputProblem {
    if (this.opts.credentials.kind === "oauth" && status === 403) {
      return new InputProblem(
        "wave-access-denied",
        "Wave refused the connection. Wave only allows \"Connect to Wave\" for businesses with an active Pro or Wave Advisor subscription, so the subscription may have ended.",
        "Reconnect to Wave, or use a Wave access key or the export files instead.",
        detail.slice(0, 500),
      );
    }
    return new InputProblem(
      status === 403 ? "wave-access-denied" : "wave-key-rejected",
      this.opts.credentials.kind === "oauth"
        ? "Wave no longer accepts this connection. It may have been disconnected in Wave."
        : "Wave didn't accept this access key. It may have been revoked, or copied incompletely.",
      this.opts.credentials.kind === "oauth" ? "Click \"Connect to Wave\" again." : "Create a new key in Wave and paste it again.",
      `HTTP ${status}: ${detail.slice(0, 500)}`,
    );
  }

  private backoff(attempt: number): number {
    return Math.min(30_000, 1000 * 2 ** attempt);
  }

  private async throttle(): Promise<void> {
    const wait = this.last + this.minInterval - this.now();
    if (wait > 0) await this.sleep(wait);
    this.last = this.now();
  }
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** Fetch every page of a paged connection. */
export async function allPages<N>(
  fetchPage: (page: number) => Promise<{ pageInfo: { totalPages: number | null }; edges: { node: N }[] } | null | undefined>,
): Promise<N[]> {
  const out: N[] = [];
  for (let page = 1; ; page++) {
    const conn = await fetchPage(page);
    if (!conn) break;
    out.push(...conn.edges.map((e) => e.node));
    if (page >= (conn.pageInfo.totalPages ?? 0)) break;
  }
  return out;
}
