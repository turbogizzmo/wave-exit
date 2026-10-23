import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import type { ReportDocument, ReportRow, ReportTable } from "./document.ts";

/**
 * Render a report to PDF: US Letter portrait, Helvetica, tables that repeat their
 * header on each new page, and a footer with the business, report and page number.
 * Deterministic: the same report and date give the same bytes.
 *
 * Helvetica covers Western European characters (WinAnsi). Anything else is shown
 * as "?"; `unprintable()` lets the output raise a Review card first.
 */

const PAGE = { w: 612, h: 792, margin: 48 };
const SIZE = { title: 18, h2: 12, body: 9, small: 7.5 };
const LINE = 12.5;

const WINANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
const printable = (ch: string) => {
  const c = ch.charCodeAt(0);
  return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WINANSI_EXTRA.includes(ch);
};

export function clean(s: string): string {
  return [...s.normalize("NFC")].map((ch) => (printable(ch) ? ch : ch === "\t" ? " " : "?")).join("");
}

/** Characters in the text that the PDF can't show. */
export function unprintable(text: string): string[] {
  return [...new Set([...text.normalize("NFC")].filter((ch) => !printable(ch) && ch !== "\n" && ch !== "\t"))];
}

export async function renderPdf(doc: ReportDocument, createdAt: Date): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${clean(doc.business)} - ${doc.title}`);
  pdf.setAuthor("Wave Exit");
  pdf.setCreator("Wave Exit");
  pdf.setProducer("Wave Exit");
  pdf.setCreationDate(createdAt);
  pdf.setModificationDate(createdAt);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const width = PAGE.w - 2 * PAGE.margin;

  let page!: PDFPage;
  let y = 0;
  const newPage = () => {
    page = pdf.addPage([PAGE.w, PAGE.h]);
    y = PAGE.h - PAGE.margin;
  };
  const ensure = (h: number, onBreak?: () => void) => {
    if (y - h < PAGE.margin + 20) {
      newPage();
      onBreak?.();
    }
  };
  const text = (s: string, x: number, size: number, font: PDFFont, color = rgb(0, 0, 0)) =>
    page.drawText(clean(s), { x, y, size, font, color });

  const wrap = (s: string, font: PDFFont, size: number, max: number): string[] => {
    const out: string[] = [];
    for (const para of clean(s).split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) <= max || !line) line = next;
        else {
          out.push(line);
          line = word;
        }
      }
      out.push(line);
    }
    return out.map((l) => fit(l, font, size, max));
  };
  const fit = (s: string, font: PDFFont, size: number, max: number) => {
    if (font.widthOfTextAtSize(s, size) <= max) return s;
    let t = s;
    while (t.length > 1 && font.widthOfTextAtSize(t + "…", size) > max) t = t.slice(0, -1);
    return t + "…";
  };

  const drawTable = (t: ReportTable) => {
    const xs: number[] = [];
    let x = PAGE.margin;
    for (const c of t.columns) {
      xs.push(x);
      x += c.width * width;
    }
    const cellW = (i: number) => t.columns[i]!.width * width - 6;
    const header = () => {
      ensure(LINE * 2);
      t.columns.forEach((c, i) => {
        const s = fit(c.title, bold, SIZE.small, cellW(i));
        const cx = c.align === "right" ? xs[i]! + cellW(i) - bold.widthOfTextAtSize(clean(s), SIZE.small) : xs[i]!;
        text(s, cx, SIZE.small, bold, rgb(0.3, 0.3, 0.3));
      });
      y -= 4;
      page.drawLine({ start: { x: PAGE.margin, y }, end: { x: PAGE.margin + width, y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
      y -= LINE - 2;
    };
    header();
    for (const r of t.rows) drawRow(r, t, xs, cellW, header);
  };

  const drawRow = (r: ReportRow, t: ReportTable, xs: number[], cellW: (i: number) => number, header: () => void) => {
    const font = r.style === "bold" || r.style === "total" || r.style === "heading" ? bold : regular;
    const indent = (r.indent ?? 0) * 10;
    // Left-aligned text cells wrap; numbers never do.
    const cells = t.columns.map((c, i) => {
      const v = r.cells[i] ?? "";
      const max = cellW(i) - (i === 0 ? indent : 0);
      return c.align === "left" ? wrap(v, font, SIZE.body, max) : [fit(v, font, SIZE.body, max)];
    });
    const height = Math.max(...cells.map((c) => c.length)) * LINE;
    ensure(height + (r.style === "total" ? 4 : 0), header);
    if (r.style === "total") {
      page.drawLine({ start: { x: PAGE.margin, y: y + LINE - 3 }, end: { x: PAGE.margin + width, y: y + LINE - 3 }, thickness: 0.4, color: rgb(0.75, 0.75, 0.75) });
    }
    const top = y;
    cells.forEach((lines, i) => {
      lines.forEach((l, k) => {
        y = top - k * LINE;
        const c = t.columns[i]!;
        const cx = c.align === "right" ? xs[i]! + cellW(i) - font.widthOfTextAtSize(l, SIZE.body) : xs[i]! + (i === 0 ? indent : 0);
        text(l, cx, SIZE.body, font, r.style === "muted" ? rgb(0.45, 0.45, 0.45) : rgb(0, 0, 0));
      });
    });
    y = top - height;
  };

  newPage();
  text(doc.title, PAGE.margin, SIZE.title, bold);
  y -= SIZE.title + 4;
  text(doc.business, PAGE.margin, SIZE.h2, regular);
  y -= LINE + 2;
  for (const l of wrap(doc.subtitle, regular, SIZE.body, width)) {
    text(l, PAGE.margin, SIZE.body, regular, rgb(0.35, 0.35, 0.35));
    y -= LINE;
  }
  y -= LINE;

  for (const s of doc.sections) {
    if (s.newPage && y < PAGE.h - PAGE.margin - 1) newPage();
    ensure(LINE * 4);
    text(s.title, PAGE.margin, SIZE.h2, bold);
    y -= LINE + 4;
    if (s.subtitle) {
      for (const l of wrap(s.subtitle, regular, SIZE.body, width)) {
        ensure(LINE);
        text(l, PAGE.margin, SIZE.body, regular, rgb(0.35, 0.35, 0.35));
        y -= LINE;
      }
    }
    for (const p of s.paragraphs ?? []) {
      for (const l of wrap(p, regular, SIZE.body, width)) {
        ensure(LINE);
        text(l, PAGE.margin, SIZE.body, regular);
        y -= LINE;
      }
      y -= 3;
    }
    if (s.table) {
      y -= 3;
      drawTable(s.table);
    }
    y -= LINE;
  }

  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    const footer = clean(`${doc.business}  -  ${doc.title}  -  Page ${i + 1} of ${pages.length}`);
    p.drawText(footer, { x: PAGE.margin, y: PAGE.margin - 20, size: SIZE.small, font: regular, color: rgb(0.45, 0.45, 0.45) });
  });
  return pdf.save({ useObjectStreams: false });
}
