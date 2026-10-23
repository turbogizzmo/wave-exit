import receiptsUrl from "@wave-exit/core/sample/receipts-export.zip?url";
import snapshotUrl from "@wave-exit/core/sample/wave-snapshot.json?url";
import transactionsUrl from "@wave-exit/core/sample/transactions-export.zip?url";
import type { WaveSnapshot } from "@wave-exit/core";
import { newProject, type ProjectStore } from "../store/projects.ts";

/**
 * "Try a sample business": the invented Maple & Pine Design LLC from the test
 * fixtures, with a Wave connection already made, so anyone can see every screen
 * without a Wave login.
 */
export async function createSampleProject(store: ProjectStore): Promise<string> {
  const get = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());
  let p = newProject("Maple & Pine Design LLC (sample)");
  p = { ...p, whose: "mine" };
  const tx = await store.storeInput(p, [{ path: "5f0c1d2e-sample.zip", bytes: await get(transactionsUrl) }]);
  const rc = await store.storeInput(p, [{ path: "owner@maple-pine.example-2026-01-15-12-00-00.zip", bytes: await get(receiptsUrl) }]);
  const snap = JSON.parse(new TextDecoder().decode(await get(snapshotUrl))) as WaveSnapshot;
  const blob = await store.storeSnapshot(p, snap);
  const now = new Date().toISOString();
  p = {
    ...p,
    inputs: { transactions: { ...tx, addedAt: now, summary: "" }, receipts: { ...rc, addedAt: now, summary: "" } },
    wave: { blob, businessId: snap.business.id, businessName: snap.business.name, email: snap.user.email, fetchedAt: snap.fetchedAt, kind: "full-access" },
  };
  return (await store.save(p)).id;
}
