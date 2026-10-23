import { zipSync } from "fflate";
import { sha256Hex, type InputFile, type Settings, type WaveSnapshot } from "@wave-exit/core";
import type { Platform } from "../platform/types.ts";
import { seal, storageKey, unseal } from "./crypto.ts";

/**
 * A project is one client business: its inputs (stored as given, encrypted), the
 * Wave pull, the Review answers and settings, and the history of outputs made.
 * The books themselves are rebuilt from the inputs whenever the project opens, so
 * nothing derived can go stale.
 */

export type Whose = "mine" | "client-access" | "client-no-access";
export type SlotId = "transactions" | "receipts";

export interface StoredInput {
  blob: string;
  fileName: string;
  addedAt: string;
  sha256: string;
  summary: string;
}

export interface ProjectStatus {
  red: number;
  amber: number;
  at: string;
  entries: number;
  firstDate: string;
  lastDate: string;
}

export interface Project {
  id: string;
  clientName: string;
  createdAt: string;
  updatedAt: string;
  whose: Whose | null;
  /** For export-file-only mode, where nothing in the files names the currency. */
  currency: string;
  inputs: Partial<Record<SlotId, StoredInput>>;
  /** Earlier versions of each input, newest first. */
  history: { slot: SlotId | "wave"; fileName: string; addedAt: string; summary: string }[];
  wave: null | { blob: string; businessId: string; businessName: string; email: string; fetchedAt: string; kind: "full-access" | "oauth" };
  settings: Settings;
  status: ProjectStatus | null;
  outputs: { at: string; ids: string[]; folder: string; files: string[] }[];
  outputOptions: Record<string, Record<string, unknown>>;
}

export const SCHEMA = 1;

export function newProject(clientName: string, now = new Date()): Project {
  const id = `p-${now.getTime().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36)}`;
  return {
    id, clientName: clientName.trim(), createdAt: now.toISOString(), updatedAt: now.toISOString(), whose: null, currency: "USD",
    inputs: {}, history: [], wave: null, settings: { scope: "full-history", resolutions: {} }, status: null, outputs: [], outputOptions: {},
  };
}

/** Keychain entry for a project's Wave access key. Projects never share keys. */
export const waveKeyName = (projectId: string) => `wave-key:${projectId}`;

export class ProjectStore {
  private key?: Promise<CryptoKey>;
  private readonly platform: Platform;

  constructor(platform: Platform) {
    this.platform = platform;
  }

  private cryptoKey() {
    return (this.key ??= storageKey(this.platform.keychain));
  }

  private async put(path: string, bytes: Uint8Array) {
    await this.platform.storage.write(path, await seal(await this.cryptoKey(), bytes));
  }

  private async get(path: string): Promise<Uint8Array | null> {
    const b = await this.platform.storage.read(path);
    return b ? unseal(await this.cryptoKey(), b) : null;
  }

  async list(): Promise<Project[]> {
    const ids = [...new Set((await this.platform.storage.list()).filter((p) => p.endsWith("/project.json")).map((p) => p.split("/")[0]!))];
    const projects: Project[] = [];
    for (const id of ids) {
      const p = await this.load(id).catch(() => null);
      if (p) projects.push(p);
    }
    return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async load(id: string): Promise<Project | null> {
    const b = await this.get(`${id}/project.json`);
    if (!b) return null;
    const { schema, project } = JSON.parse(new TextDecoder().decode(b)) as { schema: number; project: Project };
    if (schema !== SCHEMA) throw new Error(`project schema ${schema}`);
    return project;
  }

  async save(p: Project): Promise<Project> {
    const next = { ...p, updatedAt: new Date().toISOString() };
    await this.put(`${p.id}/project.json`, new TextEncoder().encode(JSON.stringify({ schema: SCHEMA, project: next })));
    return next;
  }

  async remove(id: string): Promise<void> {
    await this.platform.storage.removeProject(id);
    await this.platform.keychain.remove(waveKeyName(id));
  }

  /** Keep an input exactly as given: one file stays as is, several are kept together in a ZIP. */
  async storeInput(p: Project, files: InputFile[]): Promise<{ blob: string; fileName: string; sha256: string }> {
    // Keep file times: the transactions reader reads the export date from them.
    const bytes = files.length === 1 ? files[0]!.bytes : zipSync(Object.fromEntries(files.map((f) => [f.path, [f.bytes, { mtime: f.modified ?? new Date(1980, 0, 1) }]])));
    const sha256 = await sha256Hex(bytes);
    const blob = `inputs/${sha256.slice(0, 24)}`;
    await this.put(`${p.id}/${blob}`, bytes);
    const fileName = files.length === 1 ? files[0]!.path.split("/").pop()! : `${files[0]!.path.split("/")[0] || "files"} (${files.length} files)`;
    return { blob, fileName, sha256 };
  }

  async readInput(p: Project, blob: string): Promise<InputFile[]> {
    const b = await this.get(`${p.id}/${blob}`);
    if (!b) throw new Error(`missing input ${blob}`);
    return [{ path: "stored", bytes: b }];
  }

  async storeSnapshot(p: Project, snap: WaveSnapshot): Promise<string> {
    const blob = `wave/${snap.fetchedAt.replace(/[^0-9]/g, "")}`;
    await this.put(`${p.id}/${blob}`, new TextEncoder().encode(JSON.stringify(snap)));
    return blob;
  }

  async readSnapshot(p: Project, blob: string): Promise<unknown> {
    const b = await this.get(`${p.id}/${blob}`);
    return b ? JSON.parse(new TextDecoder().decode(b)) : null;
  }
}
