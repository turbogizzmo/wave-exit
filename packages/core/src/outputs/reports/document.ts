/**
 * A report as data: titled sections of paragraphs and tables. Built once, then
 * rendered to PDF (pdf.ts) or plain text (text.ts, used for golden tests and the
 * "copy details" view), so what the PDF says is testable without parsing a PDF.
 */
export interface ReportColumn {
  title: string;
  align: "left" | "right";
  /** Share of the page width. */
  width: number;
}

export interface ReportRow {
  cells: string[];
  style?: "normal" | "bold" | "total" | "heading" | "muted";
  indent?: number;
}

export interface ReportTable {
  columns: ReportColumn[];
  rows: ReportRow[];
}

export interface ReportSection {
  title: string;
  subtitle?: string;
  paragraphs?: string[];
  table?: ReportTable;
  /** Start on a new page. */
  newPage?: boolean;
}

export interface ReportDocument {
  title: string;
  /** Shown in every page header. */
  business: string;
  /** Shown under the title on the first page. */
  subtitle: string;
  sections: ReportSection[];
}

export function renderText(doc: ReportDocument): string {
  const out: string[] = [`# ${doc.title}`, doc.business, doc.subtitle, ""];
  for (const s of doc.sections) {
    out.push(`## ${s.title}`);
    if (s.subtitle) out.push(s.subtitle);
    for (const p of s.paragraphs ?? []) out.push(p);
    if (s.table) {
      const t = s.table;
      const widths = t.columns.map((c, i) => Math.max(c.title.length, ...t.rows.map((r) => (r.cells[i] ?? "").length + (i === 0 ? (r.indent ?? 0) * 2 : 0))));
      const fmt = (cells: string[], indent = 0) =>
        cells.map((c, i) => {
          const v = i === 0 ? " ".repeat(indent * 2) + c : c;
          return t.columns[i]!.align === "right" ? v.padStart(widths[i]!) : v.padEnd(widths[i]!);
        }).join("  ").trimEnd();
      out.push(fmt(t.columns.map((c) => c.title)));
      out.push(widths.map((w) => "-".repeat(w)).join("  "));
      for (const r of t.rows) out.push(fmt(r.cells, r.indent));
    }
    out.push("");
  }
  return out.join("\n");
}
