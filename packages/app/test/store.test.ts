import { describe, expect, it } from "vitest";
import { webPlatform } from "../src/platform/web.ts";
import { seal, storageKey, unseal, UnreadableProject } from "../src/store/crypto.ts";
import { newProject, ProjectStore, waveKeyName } from "../src/store/projects.ts";
import { routeFiles } from "../src/ui/ProjectView.tsx";
import { sampleFile } from "./helpers.tsx";

describe("encrypted storage", () => {
  it("seals with AES-GCM and refuses other keys or tampering", async () => {
    const mem = new Map<string, string>();
    const kc = { get: async (n: string) => mem.get(n) ?? null, set: async (n: string, v: string) => void mem.set(n, v) };
    const key = await storageKey(kc);
    expect(mem.get("storage-key")).toMatch(/^[A-Za-z0-9+/=]{44}$/);
    const plain = new TextEncoder().encode("client books");
    const a = await seal(key, plain);
    const b = await seal(key, plain);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false); // fresh nonce each time
    expect(new TextDecoder().decode(await unseal(key, a))).toBe("client books");
    expect(new TextDecoder().decode(a)).not.toContain("client books");
    const other = await storageKey({ get: async () => null, set: async () => {} });
    await expect(unseal(other, a)).rejects.toBeInstanceOf(UnreadableProject);
    const tampered = a.slice();
    tampered[tampered.length - 1]! ^= 1;
    await expect(unseal(key, tampered)).rejects.toBeInstanceOf(UnreadableProject);
  });

  it("saves, lists and removes projects, with their Wave key", async () => {
    const platform = webPlatform();
    const store = new ProjectStore(platform);
    const p = await store.save(newProject("Acme Bookkeeping Client"));
    await platform.keychain.set(waveKeyName(p.id), "secret");
    await store.storeInput(p, [sampleFile("transactions-export.zip")]);
    expect((await store.list()).map((x) => x.clientName)).toContain("Acme Bookkeeping Client");
    // Nothing readable at rest.
    for (const path of await platform.storage.list()) {
      const raw = new TextDecoder().decode((await platform.storage.read(path))!);
      expect(raw).not.toContain("Acme");
      expect(raw).not.toContain("accounting.csv");
    }
    await store.remove(p.id);
    expect((await store.list()).some((x) => x.id === p.id)).toBe(false);
    expect(await platform.keychain.get(waveKeyName(p.id))).toBeNull();
  });
});

describe("dropping files", () => {
  it("sends each Wave export to its slot, and explains anything else", () => {
    expect(routeFiles([sampleFile("transactions-export.zip")])).toEqual({ slot: "transactions" });
    expect(routeFiles([sampleFile("receipts-export.zip")])).toEqual({ slot: "receipts" });
    const junk = routeFiles([{ path: "notes.txt", bytes: new TextEncoder().encode("hello") }]);
    expect("problem" in junk && junk.problem.explanation).toMatch(/doesn't look like a Wave export/);
    const collection = routeFiles([{ path: "Acme – for Sam.waveexit", bytes: new Uint8Array(10) }]);
    expect("problem" in collection && collection.problem.explanation).toMatch(/collection file/);
  });
});
