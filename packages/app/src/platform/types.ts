import type { Fetch, InputFile } from "@wave-exit/core";

/**
 * Everything the app needs from the computer, behind one interface: the desktop
 * build (Tauri: app data folder, OS keychain, native dialogs, Wave called from the
 * native side) and the browser build used for development and tests.
 */
export interface Platform {
  readonly kind: "desktop" | "browser";

  /** Private storage for projects: opaque blobs by path ("<project>/project.json", "<project>/inputs/<id>"). */
  storage: {
    list(): Promise<string[]>;
    read(path: string): Promise<Uint8Array | null>;
    write(path: string, bytes: Uint8Array): Promise<void>;
    removeProject(projectId: string): Promise<void>;
  };

  /** OS keychain (desktop) for secrets: the storage key and Wave access keys. */
  keychain: {
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
    remove(name: string): Promise<void>;
  };

  /** Ask the user for files (or a folder) and read them. */
  pickInputFiles(opts: { folder?: boolean }): Promise<InputFile[] | null>;
  /** Files dropped on the window: the desktop build hands over paths, the browser build File objects. */
  onFilesDropped(handler: (files: InputFile[]) => void, onHover: (over: boolean) => void): () => void;

  /** Ask where to put outputs and write them; returns the folder shown to the user. */
  saveOutputs(files: { name: string; bytes: Uint8Array }[], suggestedFolder: string): Promise<{ folder: string; written: string[] } | null>;
  /** Show a folder in Finder / Explorer. */
  revealFolder(folder: string): Promise<void>;

  openExternal(url: string): Promise<void>;

  /** fetch for Wave's API (native in the desktop build, proxied in the browser). */
  waveFetch: Fetch;
  waveUrl: string;

  /** QuickBooks Online: sign-in and API calls (desktop only). */
  qbo: {
    /** False in builds that can't sign in to QuickBooks, with the reason. */
    available: boolean;
    reason?: string;
    /** fetch for QuickBooks's API and Intuit's token endpoint. */
    fetch: Fetch;
    /** The fixed local address Intuit redirects to after sign-in (registered on the Intuit app). */
    redirectUri: string;
    /** Open Intuit's sign-in page in the browser and wait for its reply; returns the reply URL. */
    signIn(authorizeUrl: string): Promise<string>;
  };
}
