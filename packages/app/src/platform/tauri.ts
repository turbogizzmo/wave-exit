import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Fetch, InputFile } from "@wave-exit/core";
import type { Platform } from "./types.ts";

/**
 * Desktop build. Project storage lives in the app's data folder (encrypted by the
 * app before it gets there), secrets in the OS keychain, and Wave is called through
 * Tauri's HTTP plugin, which the app's capabilities limit to gql.waveapps.com. The
 * native side only reads files the user picked or dropped, and only writes into a
 * folder the user chose. Bytes cross as raw binary, not JSON.
 */

/** A file found under the picked or dropped paths: `path` relative to what was picked, `absolute` to read it. */
interface NativeFile { path: string; absolute: string; modifiedMs: number | null; size: number }

async function read(list: NativeFile[]): Promise<InputFile[]> {
  return Promise.all(
    list.map(async (f) => ({
      path: f.path,
      bytes: new Uint8Array(await invoke<ArrayBuffer>("read_input_file", { path: f.absolute })),
      ...(f.modifiedMs ? { modified: new Date(f.modifiedMs) } : {}),
    })),
  );
}

async function listDropped(paths: string[]): Promise<NativeFile[]> {
  // The native side records dropped paths from the same window event; give it a moment if needed.
  for (let attempt = 0; ; attempt++) {
    try {
      return await invoke<NativeFile[]>("list_dropped", { paths });
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

export function tauriPlatform(): Platform {
  return {
    kind: "desktop",
    storage: {
      list: () => invoke<string[]>("storage_list"),
      read: async (path) => {
        const r = new Uint8Array(await invoke<ArrayBuffer>("storage_read", { path }));
        return r.length ? r : null;
      },
      write: (path, bytes) => invoke("storage_write", bytes, { headers: { "x-path": encodeURIComponent(path) } }),
      removeProject: (projectId) => invoke("storage_remove_project", { projectId }),
    },
    keychain: {
      get: (name) => invoke<string | null>("keychain_get", { name }),
      set: (name, value) => invoke("keychain_set", { name, value }),
      remove: (name) => invoke("keychain_remove", { name }),
    },
    async pickInputFiles({ folder }) {
      const list = await invoke<NativeFile[]>("pick_input", { folder: !!folder });
      return list.length ? read(list) : null;
    },
    onFilesDropped(handler, onHover) {
      let unlisten: (() => void) | undefined;
      let stopped = false;
      void getCurrentWebview()
        .onDragDropEvent(async (e) => {
          if (e.payload.type === "enter" || e.payload.type === "over") onHover(true);
          else if (e.payload.type === "leave") onHover(false);
          else if (e.payload.type === "drop") {
            onHover(false);
            handler(await read(await listDropped(e.payload.paths)));
          }
        })
        .then((u) => (stopped ? u() : (unlisten = u)));
      return () => {
        stopped = true;
        unlisten?.();
      };
    },
    async saveOutputs(files) {
      const folder = await invoke<string | null>("pick_output_folder");
      if (!folder) return null;
      const written: string[] = [];
      for (const f of files) {
        written.push(await invoke<string>("write_output", f.bytes, { headers: { "x-folder": encodeURIComponent(folder), "x-name": encodeURIComponent(f.name) } }));
      }
      return { folder, written };
    },
    revealFolder: (path) => revealItemInDir(path),
    openExternal: (url) => openUrl(url),
    waveFetch: ((url, init) => tauriFetch(url, init)) as Fetch,
    waveUrl: "https://gql.waveapps.com/graphql/public",
  };
}
