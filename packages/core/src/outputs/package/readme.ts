import type { Books } from "../../model/types.ts";
import type { Manifest } from "./universal-package.ts";
import { KIND_DOC, TABLES } from "./tables.ts";

/** README.html: what every file and column means, generated from the table definitions. */
export function readmeHtml(books: Books, manifest: Manifest): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const code = (s: string) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
  const checks = manifest.checks.map((c) => `<li><b>${c.id}. ${esc(c.title)}</b> — ${esc(c.status)}: ${esc(c.summary)}</li>`).join("\n");
  const tables = TABLES.map((t) => `
<h3 id="${esc(t.file)}">${esc(t.file)}</h3>
<p>${code(t.doc)} Rows: ${manifest.row_counts[t.file] ?? 0}.</p>
<table><thead><tr><th>Column</th><th>Kind</th><th>Meaning</th></tr></thead><tbody>
${t.columns.map((c) => `<tr><td><code>${esc(c.name)}</code></td><td>${c.kind}</td><td>${code(c.doc)}</td></tr>`).join("\n")}
</tbody></table>`).join("\n");
  const kinds = Object.entries(KIND_DOC).map(([k, v]) => `<tr><td>${k}</td><td>${code(v)}</td></tr>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(books.business.name)} – Wave export</title>
<style>
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #ffffff; --muted: #5f6368; --rule: #d9d9de; --code: #f3f3f5; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8e8ea; --bg: #161618; --muted: #a0a0a8; --rule: #3a3a40; --code: #26262a; } }
body { font: 15px/1.5 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: var(--fg); background: var(--bg); max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 26px; margin-bottom: 4px; } h2 { margin-top: 40px; border-bottom: 1px solid var(--rule); padding-bottom: 4px; } h3 { margin-top: 28px; }
p.lead { color: var(--muted); margin-top: 0; }
table { border-collapse: collapse; width: 100%; font-size: 14px; display: block; overflow-x: auto; }
th, td { text-align: left; vertical-align: top; padding: 6px 10px 6px 0; border-bottom: 1px solid var(--rule); }
code { background: var(--code); padding: 1px 4px; border-radius: 3px; font-size: 13px; }
</style></head><body>
<h1>${esc(books.business.name)}</h1>
<p class="lead">Wave Accounting books, ${esc(books.period.firstDate)} to ${esc(books.period.lastDate)}, converted by Wave Exit ${esc(manifest.app_version)} on ${esc(manifest.created_at.slice(0, 10))}.</p>

<h2>What this is</h2>
<p>This folder holds everything Wave Exit read from Wave for this business, as plain CSV files any accounting program or spreadsheet can open, with the receipts and a tie-out report showing the books hold together. It is a complete archive: every other Wave Exit output can be rebuilt from it.</p>
<p>${books.mode === "connected"
    ? "It was built from Wave's transactions export together with a Wave connection, so the chart of accounts is complete and balances were compared with Wave."
    : "It was built from Wave's export files only, without a Wave connection. Products, sales taxes, estimates, invoice line items and accounts with no activity aren't in those files, so they are missing or rebuilt from the ledger, and balances could not be compared with Wave."}</p>
<p>The ledger is always the full history. The cutover date (${esc(books.period.cutoverDate)}) and scope (${esc(books.settings.scope)}) recorded in <code>manifest.json</code> are used by outputs that load the books into another system.</p>

<h2>Checks</h2>
<ul>${checks}</ul>
<p>Details are in <code>tie_out_report.pdf</code>.</p>

<h2>Conventions</h2>
<ul>
<li>Text is UTF-8 with a byte-order mark, so Excel opens it with the right characters. Lines end with CRLF.</li>
<li>Dates are YYYY-MM-DD.</li>
<li>Amounts are in ${esc(books.business.currency || "the business currency")}, written as plain decimals with ${books.business.exponent} decimal places. Debits and credits are two columns of positive amounts.</li>
<li>IDs are stable: running Wave Exit again on a newer export gives the same IDs for the same records.</li>
<li>The CSV files are data, not formulas. If a text cell starts with <code>=</code>, a spreadsheet may treat it as a formula; open the files through the Wave Exit Excel workbook when that matters.</li>
</ul>
<table><thead><tr><th>Kind</th><th>Meaning</th></tr></thead><tbody>
${kinds}
</tbody></table>

<h2>Files</h2>
<ul>
<li><code>manifest.json</code>: format version, business, period, input mode, source files with SHA-256, row counts, check results, the settings and review answers used.</li>
<li><code>tie_out_report.pdf</code>: the checks, for the client file.</li>
<li><code>attachments/</code>: receipt files as Wave gave them; <code>attachments.csv</code> links each to its entry.</li>
${TABLES.map((t) => `<li><a href="#${esc(t.file)}"><code>${esc(t.file)}</code></a></li>`).join("\n")}
</ul>
${tables}

<h2>Not available from Wave</h2>
<p>Recurring invoice schedules, bank reconciliation status, bank-feed connections and payroll detail beyond Wave's payroll exports can't be read from Wave by any supported route, so they aren't here.</p>
</body></html>
`;
}
