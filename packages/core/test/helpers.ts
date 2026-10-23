import { buildBooks, fetchWaveSnapshot, fullAccessKey, readReceiptsExport, readTransactionsExport, WaveClient, type BuildInputs, type Books, type WaveSnapshot } from "../src/index.ts";
import { BUSINESS_ID, fakeWaveApi, receiptsZip, transactionsZip, type FakeApiOptions, type FxEntry } from "./fixtures/synthetic.ts";

export async function snapshot(opts: FakeApiOptions = {}): Promise<WaveSnapshot> {
  const api = fakeWaveApi(opts);
  const c = new WaveClient({ credentials: fullAccessKey("k"), fetch: api.fetch, minIntervalMs: 0, sleep: async () => {} });
  return fetchWaveSnapshot(c, BUSINESS_ID, { now: () => new Date("2026-01-16T09:00:00Z") });
}

export async function inputs(opts: { connected?: boolean; receipts?: boolean; api?: FakeApiOptions; entries?: FxEntry[] } = {}): Promise<BuildInputs> {
  const transactions = await readTransactionsExport([{ path: "export.zip", bytes: transactionsZip(opts.entries ? { entries: opts.entries } : {}) }]);
  return {
    transactions,
    ...(opts.connected !== false ? { wave: await snapshot(opts.api) } : { business: { name: "Maple & Pine Design LLC", currency: "USD" } }),
    ...(opts.receipts !== false ? { receipts: await readReceiptsExport([{ path: "r.zip", bytes: receiptsZip() }]) } : {}),
  };
}

export async function books(opts: Parameters<typeof inputs>[0] & { settings?: BuildInputs["settings"] } = {}): Promise<Books> {
  const i = await inputs(opts);
  return buildBooks({ ...i, ...(opts.settings ? { settings: opts.settings } : {}) });
}
