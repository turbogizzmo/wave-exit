import { zipSync } from "fflate";
import type { Books } from "../../model/types.ts";
import { encodeText, safeFileName, toCsv } from "../csv.ts";
import { tieOutReport } from "../reports/reports.ts";
import { renderPdf } from "../reports/pdf.ts";
import { APP_VERSION, type OutputContext, type OutputFile, type OutputPlugin } from "../types.ts";
import { readmeHtml } from "./readme.ts";
import { TABLES } from "./tables.ts";

/**
 * The universal package: the archive, and the documented contract every other
 * output could be rebuilt from. A ZIP of CSV files (spec in README.html, generated
 * from the same table definitions), a manifest, the receipts and the tie-out
 * report. Always full history, whatever the scope setting: the manifest records
 * the scope and cutover for the outputs that use them.
 */

export const PACKAGE_FORMAT = "wave-exit/universal-package";
export const PACKAGE_FORMAT_VERSION = 1;

export interface Manifest {
  format: typeof PACKAGE_FORMAT;
  format_version: number;
  app_version: string;
  created_at: string;
  business: Books["business"];
  input_mode: Books["mode"];
  period: Books["period"];
  exported_at: string | null;
  wave_fetched_at: string | null;
  scope: Books["settings"]["scope"];
  fiscal_year_end_month: number;
  source_files: Books["sources"];
  row_counts: Record<string, number>;
  checks: Books["checks"];
  settings: { resolutions: Record<string, string>; rules: Books["rules"]; rules_edited: boolean };
  reader_notes: Books["notes"];
}

export function manifestFor(books: Books, ctx: Pick<OutputContext, "createdAt" | "appVersion">, rowCounts: Record<string, number>): Manifest {
  return {
    format: PACKAGE_FORMAT,
    format_version: PACKAGE_FORMAT_VERSION,
    app_version: ctx.appVersion,
    created_at: ctx.createdAt.toISOString(),
    business: books.business,
    input_mode: books.mode,
    period: books.period,
    exported_at: books.exportedAt ?? null,
    wave_fetched_at: books.waveFetchedAt ?? null,
    scope: books.settings.scope,
    fiscal_year_end_month: books.settings.fiscalYearEndMonth ?? 12,
    source_files: books.sources,
    row_counts: rowCounts,
    checks: books.checks,
    settings: { resolutions: books.settings.resolutions, rules: books.rules, rules_edited: !!books.settings.rules },
    reader_notes: books.notes,
  };
}

export const packageFileName = (books: Books, createdAt: Date) =>
  `${safeFileName(books.business.name)} – Wave export – ${createdAt.toISOString().slice(0, 10)}.zip`;

export async function writeUniversalPackage(books: Books, ctx: OutputContext): Promise<Uint8Array> {
  const mtime = ctx.createdAt;
  const files: Record<string, [Uint8Array, { mtime: Date; level?: 0 | 6 }]> = {};
  const rowCounts: Record<string, number> = {};
  for (const t of TABLES) {
    const rows = t.rows(books);
    rowCounts[t.file] = rows.length;
    files[t.file] = [encodeText(toCsv(t.columns.map((c) => c.name), rows)), { mtime }];
  }
  for (const r of books.receipts) {
    const data = ctx.attachments.get(r.fileName);
    if (data) files[`attachments/${r.fileName}`] = [data, { mtime, level: 0 }];
  }
  rowCounts["attachments/"] = books.receipts.filter((r) => ctx.attachments.has(r.fileName)).length;
  const manifest = manifestFor(books, ctx, rowCounts);
  files["tie_out_report.pdf"] = [await renderPdf(tieOutReport(books, ctx.createdAt), ctx.createdAt), { mtime, level: 0 }];
  files["README.html"] = [encodeText(readmeHtml(books, manifest)), { mtime }];
  // manifest.json first: tools can read it without scanning the archive.
  const ordered = { "manifest.json": [encodeText(JSON.stringify(manifest, null, 2) + "\n"), { mtime }] as [Uint8Array, { mtime: Date }], ...files };
  return zipSync(ordered);
}

export const universalPackage: OutputPlugin = {
  id: "universal-package",
  group: "archive",
  title: "Universal package",
  summary: "The archive: every record as documented CSV files, with receipts and the tie-out report. Always created.",
  alwaysCreated: true,
  describe: (books) => ({
    keeps: [
      { aspect: "ledger", text: "Every ledger line, with its Wave Transaction ID and the export row it came from." },
      { aspect: "entry-types", text: "Each entry's type (expense, transfer, invoice payment…) and why." },
      { aspect: "chart-of-accounts", text: "The chart of accounts, including empty and archived accounts when connected." },
      { aspect: "contacts", text: "Customers and vendors." },
      { aspect: "contact-details", text: "Their addresses and other details." },
      { aspect: "invoices", text: "Invoices with amounts paid and owed." },
      { aspect: "invoice-lines", text: "Invoice line items." },
      { aspect: "bills", text: "Bills." },
      { aspect: "payments", text: "Payments, linked to the invoices and bills they paid." },
      { aspect: "items", text: "Products and services." },
      { aspect: "tax-rates", text: "Sales tax rates." },
      { aspect: "estimates", text: "Estimates." },
      { aspect: "attachments", text: "Receipt files, linked to their transactions where matched." },
      { aspect: "trial-balance", text: "Trial balance at the end date and the cutover date." },
      { aspect: "aging", text: "AR and AP aging at the cutover date." },
      { aspect: "tie-out", text: "The tie-out report, as evidence for the client file." },
      { aspect: "review-answers", text: "Every review item and the answer given." },
      { aspect: "source-checksums", text: "SHA-256 of every source file." },
    ],
    loses: [{ aspect: "yearly-statements", text: "No P&L or balance sheet by year: use the PDF report pack." }],
    withoutConnection: books.mode === "export-file-only"
      ? ["Products, sales taxes and estimates (not in Wave's export)", "Invoice line items (rebuilt from the ledger instead)", "Accounts with no activity", "Due dates"]
      : [],
  }),
  validate: () => [],
  async produce(books, ctx): Promise<OutputFile[]> {
    return [{ name: packageFileName(books, ctx.createdAt), bytes: await writeUniversalPackage(books, ctx), mediaType: "application/zip" }];
  },
};

export { APP_VERSION };
