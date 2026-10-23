import type { Books, Issue } from "../model/types.ts";
import { safeFileName } from "./csv.ts";
import { renderText } from "./reports/document.ts";
import { renderPdf, unprintable } from "./reports/pdf.ts";
import { reportPack } from "./reports/reports.ts";
import type { OutputPlugin } from "./types.ts";

/**
 * The PDF report pack for the client file: tie-out summary, trial balance, P&L and
 * balance sheet for each fiscal year, AR/AP aging and the general ledger.
 */
export const pdfReportPack: OutputPlugin = {
  id: "pdf-pack",
  group: "archive",
  title: "PDF report pack",
  summary: "Tie-out report, trial balance, P&L and balance sheet by year, AR/AP aging and the general ledger, for the client file.",
  describe: () => ({
    keeps: [
      { aspect: "tie-out", text: "The tie-out checks and review answers." },
      { aspect: "trial-balance", text: "Trial balance at the end date and the cutover date." },
      { aspect: "yearly-statements", text: "P&L and balance sheet for every fiscal year (calendar years unless set otherwise)." },
      { aspect: "aging", text: "AR and AP aging at the cutover date, by contact and document." },
      { aspect: "ledger", text: "The general ledger, account by account with running balances." },
      { aspect: "review-answers", text: "Every review item and its answer." },
      { aspect: "source-checksums", text: "SHA-256 of every source file." },
    ],
    loses: [
      { aspect: "attachments", text: "No receipt files." },
      { aspect: "invoice-lines", text: "No invoice line items." },
      { aspect: "contact-details", text: "Contact names only." },
    ],
    withoutConnection: [],
  }),
  validate(books: Books): Issue[] {
    const bad = unprintable(renderText(reportPack(books, new Date(0))));
    return bad.length
      ? [{
          id: "pdf-unprintable", kind: "output-limit", severity: "amber",
          title: "Some characters can't be shown in the PDF reports",
          explanation: `The PDF reports use a standard font that lacks ${bad.slice(0, 10).map((c) => `"${c}"`).join(", ")}. Those characters print as "?". The universal package and Excel workbook keep them.`,
          options: [], refs: [],
        }]
      : [];
  },
  async produce(books, ctx) {
    return [{
      name: `${safeFileName(books.business.name)} – report pack – ${ctx.createdAt.toISOString().slice(0, 10)}.pdf`,
      bytes: await renderPdf(reportPack(books, ctx.createdAt), ctx.createdAt), mediaType: "application/pdf",
    }];
  },
};
