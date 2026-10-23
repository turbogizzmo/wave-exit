// Layer 1: input readers (one per input slot). They know file formats and Wave's API, not accounting.
export * from "./input/files.ts";
export * from "./readers/common.ts";
export * from "./readers/transactions-export.ts";
export * from "./readers/receipts-export.ts";
export * from "./readers/wave-api/auth.ts";
export * from "./readers/wave-api/client.ts";
export * from "./readers/wave-api/snapshot.ts";

// Layer 2: the model. Merge, classify, open items, tie-out checks.
export * from "./model/types.ts";
export * from "./model/rules.ts";
export * from "./model/subtypes.ts";
export * from "./model/build.ts";
export * from "./model/identity.ts";
export * from "./model/ledger.ts";
export { agingAt, bucketFor } from "./model/open-items.ts";

export * from "./money.ts";
export * from "./problems.ts";

// Layer 3: output plug-ins over the books.
export * from "./outputs/types.ts";
export * from "./outputs/catalog.ts";
export { universalPackage, writeUniversalPackage, packageFileName, PACKAGE_FORMAT, type Manifest } from "./outputs/package/universal-package.ts";
export { readUniversalPackage } from "./outputs/package/read-package.ts";
export { TABLES, type TableSpec } from "./outputs/package/tables.ts";
export { glCsv, glRows, GL_COLUMNS } from "./outputs/gl-csv.ts";
export { excelWorkbook, workbookSheets } from "./outputs/excel.ts";
export { pdfReportPack } from "./outputs/pdf-pack.ts";
export { reportPack, tieOutReport } from "./outputs/reports/reports.ts";
export { renderText, type ReportDocument } from "./outputs/reports/document.ts";
export { renderPdf } from "./outputs/reports/pdf.ts";
export * from "./outputs/reports/statements.ts";
export { scopedLedger, fiscalYearStart, OPENING_ENTRY_ID } from "./model/opening.ts";
