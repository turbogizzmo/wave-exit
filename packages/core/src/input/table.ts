import { parse } from "csv-parse/sync";
import { InputProblem } from "../problems.ts";

/** A sheet of text cells with a header row. Readers address cells by header name only. */
export interface Table {
  /** File the table came from, for messages. */
  source: string;
  headers: string[];
  rows: string[][];
}

export function readCsv(bytes: Uint8Array, source: string): Table {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (e) {
    throw new InputProblem(
      "bad-value",
      `"${source}" isn't readable text. Wave's exports are plain UTF-8 CSV files, so this file may have been opened and re-saved in another program.`,
      "Use the original file from Wave's download, without opening and saving it first.",
      String(e),
    );
  }
  let records: string[][];
  try {
    records = parse(text, { bom: true, relax_quotes: false, skip_empty_lines: true }) as string[][];
  } catch (e) {
    throw new InputProblem(
      "damaged-file",
      `"${source}" has a line that doesn't follow the CSV layout, so it may be damaged or cut off.`,
      "Download the export again from Wave.",
      String(e),
    );
  }
  const [headers, ...rows] = records;
  if (!headers) return { source, headers: [], rows: [] };
  return { source, headers, rows };
}

/**
 * Column lookup by exact header text. Raises one problem naming every missing
 * required column, so the user (or support) sees the whole picture at once.
 */
export class Columns<K extends string> {
  private readonly index = new Map<string, number>();
  readonly table: Table;

  constructor(table: Table, required: readonly K[]) {
    this.table = table;
    table.headers.forEach((h, i) => {
      if (!this.index.has(h)) this.index.set(h, i);
    });
    const missing = required.filter((r) => !this.index.has(r));
    if (missing.length) {
      throw new InputProblem(
        "missing-columns",
        `"${table.source}" is missing ${missing.length === 1 ? "the column" : "the columns"} ${missing.map((m) => `"${m}"`).join(", ")}. Wave may have changed its export, or the file was edited.`,
        "Use an untouched export from Wave. If it still fails, copy the details for support.",
        `headers: ${JSON.stringify(table.headers)}`,
      );
    }
  }

  has(name: string): boolean {
    return this.index.has(name);
  }

  get(row: string[], name: K | string): string {
    const i = this.index.get(name);
    return i === undefined ? "" : (row[i] ?? "");
  }
}
