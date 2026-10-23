export interface SourceFileInfo {
  name: string;
  bytes: number;
  sha256: string;
  /** Data rows read (for row-count tie-out). */
  rows: number;
}

/** Something a reader noticed that isn't fatal; shown in Review. */
export interface ReaderNote {
  severity: "info" | "warning";
  message: string;
  rows?: number[];
}
