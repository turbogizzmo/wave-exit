import { baseName, expandZips, sha256Hex, type InputFile } from "../input/files.ts";
import { InputProblem } from "../problems.ts";
import type { ReaderNote } from "./common.ts";

/**
 * Reader for Wave's "Export all receipts as a ZIP file": a flat ZIP of the original
 * uploads named `YYYY-MM-DD-<transaction description>.<ext>`, with spaces turned
 * into `_` and characters such as `/` dropped. (In the real export every description
 * began with a 6-digit bank reference, which once looked like a separate serial
 * number; it is part of the description.) Linking happens in the model by date +
 * description.
 */

export interface ReceiptFile {
  fileName: string;
  /** Transaction date encoded in the file name; "" if the name doesn't follow Wave's pattern. */
  date: string;
  /** The description part with `_` turned back into spaces. */
  description: string;
  extension: string;
  bytes: number;
  sha256: string;
  data: Uint8Array;
}

export interface ReceiptsExport {
  kind: "receipts-export";
  receipts: ReceiptFile[];
  notes: ReaderNote[];
}

const NAME = /^(\d{4}-\d{2}-\d{2})-(.+?)(?:\.([A-Za-z0-9]{1,5}))?$/;

export function looksLikeReceiptsExport(files: InputFile[]): boolean {
  const all = expandZips(files);
  return all.length > 0 && all.filter((f) => NAME.test(baseName(f.path))).length >= all.length / 2;
}

export async function readReceiptsExport(input: InputFile[]): Promise<ReceiptsExport> {
  const files = expandZips(input);
  const receipts: ReceiptFile[] = [];
  const unrecognised: string[] = [];
  for (const f of files) {
    const name = baseName(f.path);
    const m = NAME.exec(name);
    if (!m) unrecognised.push(name);
    receipts.push({
      fileName: name,
      date: m?.[1] ?? "",
      description: (m?.[2] ?? name).replaceAll("_", " ").trim(),
      extension: (m?.[3] ?? name.split(".").pop() ?? "").toLowerCase(),
      bytes: f.bytes.length,
      sha256: await sha256Hex(f.bytes),
      data: f.bytes,
    });
  }
  if (receipts.length === unrecognised.length) {
    throw new InputProblem(
      "not-a-wave-export",
      "This doesn't look like Wave's receipts export: none of the files are named the way Wave names receipts (date, then description).",
      `In Wave, go to Settings → Data Export and choose "Export all receipts as a ZIP file".`,
      `files: ${files.slice(0, 20).map((f) => f.path).join(", ")}`,
    );
  }
  receipts.sort((a, b) => a.fileName.localeCompare(b.fileName));
  const notes: ReaderNote[] = unrecognised.length
    ? [{ severity: "warning", message: `${unrecognised.length} files in the receipts export don't follow Wave's naming and were kept as unlinked attachments: ${unrecognised.slice(0, 5).join(", ")}${unrecognised.length > 5 ? "…" : ""}` }]
    : [];
  return { kind: "receipts-export", receipts, notes };
}
