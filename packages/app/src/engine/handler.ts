import {
  APP_VERSION, buildBooks, createOutputs, InputProblem, matchExportToBusiness, OUTPUTS, OutputsBlocked, parseWaveSnapshot,
  readReceiptsExport, readTransactionsExport, type Books, type ReceiptsExport,
} from "@wave-exit/core";
import type { BuildResult, Problem, Request, Response } from "./protocol.ts";

/**
 * Reads the inputs and builds the books. Runs in a worker, off the screen's thread,
 * so a large export doesn't freeze the window. Keeps the last books (and the receipt files) to make
 * outputs from without sending them back and forth.
 */

type Post = (m: Response, transfer?: Transferable[]) => void;

const asProblem = (e: unknown): Problem =>
  e instanceof InputProblem
    ? { code: e.code, explanation: e.explanation, nextStep: e.nextStep, ...(e.detail ? { detail: e.detail } : {}) }
    : { code: "unexpected", explanation: "Something went wrong while reading the books.", nextStep: "Try again. If it keeps happening, copy the details for support.", detail: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e) };

/** Handle one request. State (the last books) lives in the returned closure. */
export function makeHandler(post: Post): (req: Request) => Promise<void> {
  let last: { books: Books; receipts?: ReceiptsExport } | undefined;
  return async (req) => {
    if (req.type === "build") {
      let slot: "transactions" | "receipts" | "wave" = "transactions";
      try {
        post({ type: "progress", id: req.id, step: "Reading the transactions export…" });
        const tx = await readTransactionsExport(req.transactions);
        post({ type: "progress", id: req.id, step: `Reading ${tx.summary.transactions.toLocaleString("en-US")} transactions…` });
        slot = "receipts";
        const receipts = req.receipts ? await readReceiptsExport(req.receipts) : undefined;
        slot = "wave";
        const wave = req.snapshot ? parseWaveSnapshot(req.snapshot) : undefined;
        slot = "transactions";
        post({ type: "progress", id: req.id, step: "Matching accounts, invoices and receipts, and running the checks…" });
        const books = buildBooks({ transactions: tx, ...(wave ? { wave } : {}), ...(receipts ? { receipts } : {}), settings: req.settings, business: req.business, today: req.today });
        last = { books, ...(receipts ? { receipts } : {}) };
        const result: BuildResult = {
          books,
          summary: {
            transactions: `${tx.summary.transactions.toLocaleString("en-US")} transactions, ${tx.summary.firstDate} to ${tx.summary.lastDate}`,
            ...(receipts ? { receipts: `${receipts.receipts.length.toLocaleString("en-US")} receipt files` } : {}),
          },
          ...(wave ? { businessMatch: matchExportToBusiness(tx, wave) } : {}),
          readerNotes: [...tx.notes, ...(receipts?.notes ?? [])].map((n) => n.message),
        };
        post({ type: "done", id: req.id, result });
      } catch (e) {
        post({ type: "failed", id: req.id, slot, problem: asProblem(e) });
      }
    } else if (req.type === "validate") {
      post({ type: "done", id: req.id, result: last ? Object.fromEntries(OUTPUTS.map((p) => [p.id, p.validate(last!.books)])) : {} });
    } else if (req.type === "outputs") {
      try {
        if (!last) throw new Error("no books built yet");
        post({ type: "progress", id: req.id, step: "Making the outputs…" });
        const attachments = new Map((last.receipts?.receipts ?? []).map((r) => [r.fileName, r.data] as const));
        const results = await createOutputs(last.books, req.ids, { createdAt: new Date(req.createdAt), appVersion: APP_VERSION, attachments, options: req.options });
        const files = results.flatMap((r) => r.files.map((f) => ({ name: f.name, bytes: f.bytes, outputId: r.plugin.id })));
        post({ type: "done", id: req.id, result: { files, warnings: results.flatMap((r) => r.issues) } }, files.map((f) => f.bytes.buffer as ArrayBuffer));
      } catch (e) {
        post({
          type: "failed", id: req.id, slot: "outputs",
          problem: e instanceof OutputsBlocked
            ? { code: "blocked", explanation: e.message, nextStep: "Answer the red items on the Review screen first." }
            : asProblem(e),
        });
      }
    }
  };
}
