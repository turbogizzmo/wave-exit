import type { Books, BusinessMatch, InputFile, Issue, OutputContext, Settings } from "@wave-exit/core";

/** Messages between the screens and the books worker (all structured-clone safe, bigint included). */

export interface Problem { code: string; explanation: string; nextStep: string; detail?: string }

export interface BuildRequest {
  type: "build";
  id: number;
  transactions: InputFile[];
  receipts?: InputFile[];
  snapshot?: unknown;
  settings: Settings;
  business: { name: string; currency: string };
  today: string;
}

export interface OutputsRequest {
  type: "outputs";
  id: number;
  ids: string[];
  createdAt: string;
  options: OutputContext["options"];
}

export interface ValidateRequest { type: "validate"; id: number }

export type Request = BuildRequest | OutputsRequest | ValidateRequest;

export interface BuildResult {
  books: Books;
  summary: { transactions: string; receipts?: string };
  businessMatch?: BusinessMatch;
  readerNotes: string[];
}

export interface OutputsResult {
  files: { name: string; bytes: Uint8Array; outputId: string }[];
  warnings: Issue[];
}

export type Response =
  | { type: "progress"; id: number; step: string }
  | { type: "done"; id: number; result: BuildResult | OutputsResult | Record<string, Issue[]> }
  | { type: "failed"; id: number; slot?: "transactions" | "receipts" | "wave" | "outputs"; problem: Problem };
