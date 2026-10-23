import type { Books, Issue } from "../model/types.ts";

/**
 * Every output is a plug-in over the merged books with one interface: it says up
 * front what the destination keeps and loses, checks whether it can represent these
 * books (raising Review cards if not), and produces its files. A new destination is
 * one new module plus one line in the catalog.
 */

export type OutputGroup = "archive" | "review" | "import-files" | "direct-load" | "plain-text";

/** Things an output can keep or lose; tests check each claim against the files produced. */
export type Aspect =
  | "ledger"
  | "entry-types"
  | "chart-of-accounts"
  | "contacts"
  | "contact-details"
  | "invoices"
  | "invoice-lines"
  | "bills"
  | "payments"
  | "items"
  | "tax-rates"
  | "estimates"
  | "attachments"
  | "trial-balance"
  | "aging"
  | "tie-out"
  | "yearly-statements"
  | "review-answers"
  | "source-checksums";

export interface Claim {
  aspect: Aspect;
  /** Plain-English sentence for the output card. */
  text: string;
}

export interface OutputDescription {
  keeps: Claim[];
  loses: Claim[];
  /** What this output can't carry when there is no Wave connection (export-file-only mode). */
  withoutConnection: string[];
}

export interface OutputFile {
  /** File name, or a path inside a folder output. */
  name: string;
  bytes: Uint8Array;
  mediaType: string;
}

export interface OutputContext {
  /** When the output is made; fixed in tests so files are byte-for-byte repeatable. */
  createdAt: Date;
  appVersion: string;
  /** Receipt files by name, for outputs that carry attachments. */
  attachments: ReadonlyMap<string, Uint8Array>;
}

export interface OutputPlugin {
  id: string;
  group: OutputGroup;
  title: string;
  /** One line for the card. */
  summary: string;
  /** The universal package is always made with the first output of any kind. */
  alwaysCreated?: boolean;
  describe(books: Books): OutputDescription;
  /** Review cards for anything this destination can't represent. Red ones block it. */
  validate(books: Books): Issue[];
  produce(books: Books, ctx: OutputContext): Promise<OutputFile[]>;
}

export const APP_VERSION = "0.3.0";
