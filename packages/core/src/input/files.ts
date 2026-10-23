import { unzipSync } from "fflate";
import { InputProblem } from "../problems.ts";

/**
 * One file as handed to the readers. The app layer turns whatever the user dropped
 * (a ZIP, an unzipped folder, loose files) into a list of these; `path` is the
 * name relative to what was dropped, with `/` separators.
 */
export interface InputFile {
  path: string;
  bytes: Uint8Array;
  /** Last-modified time if known (ZIP entry time or file system mtime). */
  modified?: Date;
}

export const baseName = (path: string): string => path.split("/").pop() ?? path;

export function isZip(f: InputFile): boolean {
  const b = f.bytes;
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05);
}

/**
 * Expand ZIPs into their member files. Directory entries and macOS metadata
 * (`__MACOSX/`, `.DS_Store`) are dropped. A damaged or cut-off ZIP raises a
 * plain-English problem rather than a library error.
 */
export function expandZips(files: InputFile[]): InputFile[] {
  const out: InputFile[] = [];
  for (const f of files) {
    if (!isZip(f)) {
      out.push(f);
      continue;
    }
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(f.bytes);
    } catch (e) {
      throw new InputProblem(
        "damaged-file",
        `"${baseName(f.path)}" is damaged or incomplete, so it can't be opened. This usually means the download was cut off.`,
        "Download the export again from Wave's email (the link works for 24 hours), or request a new export.",
        String(e),
      );
    }
    for (const [name, bytes] of Object.entries(entries)) {
      if (name.endsWith("/") || name.startsWith("__MACOSX/") || baseName(name) === ".DS_Store") continue;
      out.push({ path: name, bytes, ...(f.modified ? { modified: f.modified } : {}) });
    }
  }
  return out;
}

/** Read a ZIP's entry timestamps without inflating it (for "when was this exported"). */
export function zipEntryTimes(zip: Uint8Array): Map<string, Date> {
  // Walk the central directory: signature 0x02014b50, DOS time at +12, date at +14,
  // name length at +28, extra at +30, comment at +32, name at +46.
  const times = new Map<string, Date>();
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return times;
  let p = dv.getUint32(eocd + 16, true);
  const count = dv.getUint16(eocd + 10, true);
  const dec = new TextDecoder();
  for (let n = 0; n < count && p + 46 <= zip.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const time = dv.getUint16(p + 12, true);
    const date = dv.getUint16(p + 14, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    // DOS times carry no time zone; Wave's are as written by its server.
    times.set(name, new Date(Date.UTC(
      ((date >> 9) & 0x7f) + 1980, ((date >> 5) & 0x0f) - 1, date & 0x1f,
      (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2,
    )));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return times;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
