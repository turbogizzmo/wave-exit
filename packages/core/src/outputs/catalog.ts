import { blockingItems } from "../model/build.ts";
import type { Books, Issue } from "../model/types.ts";
import { excelWorkbook } from "./excel.ts";
import { glCsv } from "./gl-csv.ts";
import { universalPackage } from "./package/universal-package.ts";
import { pdfReportPack } from "./pdf-pack.ts";
import type { OutputContext, OutputFile, OutputPlugin } from "./types.ts";

/** Every output card, in the order the Outputs screen shows them. A new destination is one line here. */
export const OUTPUTS: readonly OutputPlugin[] = [universalPackage, pdfReportPack, excelWorkbook, glCsv];

export class OutputsBlocked extends Error {
  readonly issues: Issue[];
  constructor(issues: Issue[], message: string) {
    super(message);
    this.issues = issues;
  }
}

/**
 * Make the chosen outputs. Refuses while Review has red items, and always adds the
 * universal package (it is the archive).
 */
export async function createOutputs(books: Books, chosen: readonly string[], ctx: OutputContext): Promise<{ plugin: OutputPlugin; files: OutputFile[]; issues: Issue[] }[]> {
  const blocked = blockingItems(books);
  if (blocked.issues.length || blocked.checks.length) {
    throw new OutputsBlocked(blocked.issues, `Review has ${blocked.issues.length + blocked.checks.length} red items to answer before outputs can be made.`);
  }
  const ids = new Set(chosen);
  for (const p of OUTPUTS) if (p.alwaysCreated) ids.add(p.id);
  const plugins = OUTPUTS.filter((p) => ids.has(p.id));
  const unknown = [...ids].filter((id) => !OUTPUTS.some((p) => p.id === id));
  if (unknown.length) throw new Error(`Unknown output: ${unknown.join(", ")}`);
  const results = [];
  for (const plugin of plugins) {
    const issues = plugin.validate(books);
    const red = issues.filter((i) => i.severity === "red" && !books.settings.resolutions[i.id]);
    if (red.length) throw new OutputsBlocked(red, `${plugin.title} can't be made: ${red[0]!.title}.`);
    results.push({ plugin, files: await plugin.produce(books, ctx), issues });
  }
  return results;
}
