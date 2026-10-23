import type { Fetch, InputFile } from "@wave-exit/core";
import type { Platform } from "./types.ts";

/**
 * Browser build, for development and tests. Storage and the "keychain" live in
 * IndexedDB (not as safe as the OS keychain, so this build is for development
 * only); outputs are saved as downloads.
 */

const DB = "wave-exit";
const STORES = ["blobs", "secrets"] as const;

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => STORES.forEach((s) => req.result.objectStoreNames.contains(s) || req.result.createObjectStore(s));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(store: (typeof STORES)[number], mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    // Close once done, so the database can be upgraded or deleted while the app runs.
    t.oncomplete = () => d.close();
    t.onerror = t.onabort = () => {
      d.close();
      reject(t.error ?? r.error);
    };
    t.addEventListener("complete", () => resolve(r.result));
  });
}

async function fileToInput(f: File, path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name): Promise<InputFile> {
  return { path, bytes: new Uint8Array(await f.arrayBuffer()), modified: new Date(f.lastModified) };
}

async function entryFiles(entry: FileSystemEntry, prefix = ""): Promise<InputFile[]> {
  if (entry.isFile) {
    const f = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    return [await fileToInput(f, prefix + f.name)];
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    all.push(...batch);
  }
  return (await Promise.all(all.map((e) => entryFiles(e, `${prefix}${entry.name}/`)))).flat();
}

export function webPlatform(opts: { fetch?: Fetch } = {}): Platform {
  return {
    kind: "browser",
    storage: {
      list: async () => ((await tx("blobs", "readonly", (s) => s.getAllKeys())) as string[]).sort(),
      read: async (path) => {
        const v = await tx<ArrayBuffer | undefined>("blobs", "readonly", (s) => s.get(path));
        return v ? new Uint8Array(v) : null;
      },
      write: async (path, bytes) => {
        await tx("blobs", "readwrite", (s) => s.put(bytes.slice().buffer, path));
      },
      removeProject: async (id) => {
        await tx("blobs", "readwrite", (s) => s.delete(IDBKeyRange.bound(`${id}/`, `${id}/￿`)));
      },
    },
    keychain: {
      get: async (name) => (await tx<string | undefined>("secrets", "readonly", (s) => s.get(name))) ?? null,
      set: async (name, value) => void (await tx("secrets", "readwrite", (s) => s.put(value, name))),
      remove: async (name) => void (await tx("secrets", "readwrite", (s) => s.delete(name))),
    },
    pickInputFiles: ({ folder }) =>
      new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        if (folder) input.webkitdirectory = true;
        input.onchange = async () => resolve(input.files?.length ? await Promise.all([...input.files].map((f) => fileToInput(f))) : null);
        input.oncancel = () => resolve(null);
        input.click();
      }),
    onFilesDropped(handler, onHover) {
      let depth = 0;
      const over = (e: DragEvent) => {
        if (!e.dataTransfer?.types.includes("Files")) return;
        e.preventDefault();
      };
      const enter = (e: DragEvent) => {
        if (!e.dataTransfer?.types.includes("Files")) return;
        depth++;
        onHover(true);
      };
      const leave = () => {
        depth = Math.max(0, depth - 1);
        if (!depth) onHover(false);
      };
      const drop = async (e: DragEvent) => {
        e.preventDefault();
        depth = 0;
        onHover(false);
        const items = [...(e.dataTransfer?.items ?? [])].map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
        const files = items.length
          ? (await Promise.all(items.map((i) => entryFiles(i)))).flat()
          : await Promise.all([...(e.dataTransfer?.files ?? [])].map((f) => fileToInput(f)));
        if (files.length) handler(files);
      };
      window.addEventListener("dragover", over);
      window.addEventListener("dragenter", enter);
      window.addEventListener("dragleave", leave);
      window.addEventListener("drop", drop);
      return () => {
        window.removeEventListener("dragover", over);
        window.removeEventListener("dragenter", enter);
        window.removeEventListener("dragleave", leave);
        window.removeEventListener("drop", drop);
      };
    },
    async saveOutputs(files) {
      for (const f of files) {
        const url = URL.createObjectURL(new Blob([f.bytes.slice().buffer]));
        const a = document.createElement("a");
        a.href = url;
        a.download = f.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
      return { folder: "your browser's Downloads folder", written: files.map((f) => f.name) };
    },
    revealFolder: async () => {},
    openExternal: async (url) => void window.open(url, "_blank", "noopener"),
    waveFetch: opts.fetch ?? (((url, init) => fetch(url, init)) as Fetch),
    waveUrl: "/wave-graphql",
    qbo: {
      available: false,
      reason: "Loading into QuickBooks works in the desktop app, which can sign in to QuickBooks and keep the connection in the computer's keychain.",
      fetch: (() => Promise.reject(new Error("not available in the browser build"))) as unknown as Fetch,
      redirectUri: "http://localhost:53682/callback",
      signIn: () => Promise.reject(new Error("not available in the browser build")),
    },
  };
}
