/**
 * CSV for the archive: UTF-8 with a byte-order mark (so Excel opens it cleanly),
 * CRLF line ends, fields quoted only when they must be. Values are written as they
 * are; the Excel workbook is the safe way to open untrusted text in a spreadsheet.
 */
const BOM = "﻿";

export function csvField(v: string): string {
  return /[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return BOM + [header, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

export const encodeText = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A safe file name from a business name: no path separators or characters Windows refuses. */
export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 120) || "Wave business";
}
