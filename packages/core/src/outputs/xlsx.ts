import { strToU8, zipSync } from "fflate";

/**
 * A small, dependency-free XLSX (Office Open XML) writer: just what the review
 * workbook needs. Inline strings (never formulas from data, so a cell that starts
 * with "=" stays text), numbers with formats, dates, formulas with cached values,
 * a frozen header row, autofilter and column widths. Deterministic output.
 */

export type CellValue =
  | { t: "s"; v: string }
  /** `v` may be a plain decimal string, written as is (exact). */
  | { t: "n"; v: number | string; fmt?: "amount" | "integer" | "decimal" }
  | { t: "d"; v: string } // ISO date
  | { t: "b"; v: boolean }
  | { t: "f"; f: string; v: number | string; fmt?: "amount" }
  | null;

export interface Sheet {
  name: string;
  columns: { header: string; width: number }[];
  rows: CellValue[][];
  /** Bold rows (0-based, excluding the header). */
  boldRows?: number[];
  freezeHeader?: boolean;
  autofilter?: boolean;
}

// Style indexes into cellXfs below.
const STYLE = { text: 0, header: 1, amount: 2, date: 3, integer: 4, decimal: 5, boldText: 6, boldAmount: 7 } as const;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    // XML 1.0 forbids most control characters.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "");

export function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Excel serial date (1900 system) for an ISO date. */
export function excelDate(iso: string): number {
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

export const SHEET_NAME_MAX = 31;

export function safeSheetName(s: string): string {
  return s.replace(/[\\/?*[\]:]/g, " ").slice(0, SHEET_NAME_MAX);
}

function sheetXml(sheet: Sheet): string {
  const bold = new Set(sheet.boldRows ?? []);
  const lastCol = colName(Math.max(0, sheet.columns.length - 1));
  const rows: string[] = [];
  rows.push(`<row r="1">${sheet.columns.map((c, i) => `<c r="${colName(i)}1" s="${STYLE.header}" t="inlineStr"><is><t xml:space="preserve">${esc(c.header)}</t></is></c>`).join("")}</row>`);
  sheet.rows.forEach((row, ri) => {
    const r = ri + 2;
    const isBold = bold.has(ri);
    const cells = row.map((cell, ci) => {
      if (cell == null) return "";
      const ref = `${colName(ci)}${r}`;
      switch (cell.t) {
        case "s": return `<c r="${ref}" s="${isBold ? STYLE.boldText : STYLE.text}" t="inlineStr"><is><t xml:space="preserve">${esc(cell.v)}</t></is></c>`;
        case "n": return `<c r="${ref}" s="${cell.fmt === "integer" ? STYLE.integer : cell.fmt === "decimal" ? STYLE.decimal : isBold ? STYLE.boldAmount : STYLE.amount}"><v>${cell.v}</v></c>`;
        case "d": return `<c r="${ref}" s="${STYLE.date}"><v>${excelDate(cell.v)}</v></c>`;
        case "b": return `<c r="${ref}" t="b"><v>${cell.v ? 1 : 0}</v></c>`;
        case "f": return `<c r="${ref}" s="${isBold ? STYLE.boldAmount : STYLE.amount}"><f>${esc(cell.f)}</f><v>${cell.v}</v></c>`;
      }
    }).join("");
    rows.push(`<row r="${r}">${cells}</row>`);
  });
  const lastRow = sheet.rows.length + 1;
  const pane = sheet.freezeHeader !== false
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>`
    : `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;
  const cols = sheet.columns.length ? `<cols>${sheet.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join("")}</cols>` : "";
  const filter = sheet.autofilter !== false && sheet.columns.length ? `<autoFilter ref="A1:${lastCol}${lastRow}"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:${lastCol}${lastRow}"/>${pane}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows.join("")}</sheetData>${filter}</worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00;(#,##0.00)"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/><numFmt numFmtId="166" formatCode="0.######"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEDEDED"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFA6A6A6"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function definedNames(sheets: Sheet[]): string {
  const names = sheets
    .map((s, i) => (s.autofilter !== false && s.columns.length
      ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(safeSheetName(s.name)).replace(/'/g, "''")}'!$A$1:$${colName(s.columns.length - 1)}$${s.rows.length + 1}</definedName>`
      : ""))
    .join("");
  return names ? `<definedNames>${names}</definedNames>` : "";
}

export function writeXlsx(sheets: Sheet[], meta: { title: string; created: Date }): Uint8Array {
  const mtime = meta.created;
  const iso = meta.created.toISOString().replace(/\.\d{3}Z$/, "Z");
  const files: Record<string, [Uint8Array, { mtime: Date }]> = {};
  const put = (name: string, xml: string) => (files[name] = [strToU8(xml), { mtime }]);
  put("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`);
  put("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
  put("docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(meta.title)}</dc:title><dc:creator>Wave Exit</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified></cp:coreProperties>`);
  put("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${esc(safeSheetName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>${definedNames(sheets)}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`);
  put("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  put("xl/styles.xml", STYLES);
  sheets.forEach((s, i) => put(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)));
  return zipSync(files);
}
