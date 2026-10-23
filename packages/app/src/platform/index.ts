import type { Platform } from "./types.ts";

export type { Platform } from "./types.ts";

/** The desktop build when running inside Tauri, otherwise the browser build. */
export async function detectPlatform(): Promise<Platform> {
  if ("__TAURI_INTERNALS__" in window) return (await import("./tauri.ts")).tauriPlatform();
  return (await import("./web.ts")).webPlatform();
}
