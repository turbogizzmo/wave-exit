// Writes site/help.html from the app's help content (src/help/content.ts), so the
// website and the app always say the same thing. Run: npm run help -w @wave-exit/app
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HELP, type Block } from "../src/help/content.ts";

const SITE = join(import.meta.dirname, "..", "..", "..", "site");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const block = (b: Block): string => {
  if ("p" in b) return `<p>${esc(b.p)}</p>`;
  if ("note" in b) return `<p class="callout">${esc(b.note)}</p>`;
  if ("steps" in b) return `<ol>${b.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`;
  if ("list" in b) return `<ul>${b.list.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`;
  return `<div class="scroll"><table><thead><tr>${b.table.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${b.table.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
};

export function helpHtml(): string {
  const index = readFileSync(join(SITE, "index.html"), "utf8");
  const style = /<style>[\s\S]*?<\/style>/.exec(index)![0];
  const toc = HELP.map((s) => `<div class="toc-group"><h3>${esc(s.title)}</h3><ul>${s.topics.map((t) => `<li><a href="#${t.id}">${esc(t.title)}</a></li>`).join("")}</ul></div>`).join("");
  const body = HELP.map((s) => `<section><div class="wrap"><h2>${esc(s.title)}</h2>${s.topics.map((t) => `<article id="${t.id}" class="topic"><h3>${esc(t.title)}</h3>${t.blocks.map(block).join("\n")}</article>`).join("\n")}</div></section>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wave Exit help</title>
<meta name="description" content="How to use Wave Exit: getting files from Wave, connecting, the checks, the outputs, and common messages.">
<link rel="icon" href="icon.png">
<!-- Generated from packages/app/src/help/content.ts by packages/app/scripts/build-help.ts. Edit the content there, not here. -->
${style}
<style>
.toc { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.toc-group h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 6px; }
.toc-group ul { list-style: none; padding: 0; margin: 0; }
.toc-group li + li { margin-top: 4px; }
.topic { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-top: 16px; scroll-margin-top: 16px; }
.topic ol, .topic ul { padding-left: 22px; }
.topic li + li { margin-top: 6px; }
.callout { background: var(--accent-2); border-radius: 8px; padding: 10px 14px; }
</style>
</head>
<body>
<header class="top">
  <div class="wrap">
    <a class="brand" href="index.html"><img src="icon.png" alt=""> Wave Exit</a>
    <nav aria-label="Sections">
      <a href="index.html">Home</a>
      <a href="index.html#download">Download</a>
      <a href="https://github.com/turbogizzmo/wave-exit">GitHub</a>
    </nav>
  </div>
</header>
<main>
  <div class="wrap hero" style="padding-bottom: 24px">
    <h1>Help</h1>
    <p class="lead">Everything in Wave Exit's Help panel, on one page. In the app, click Help at the top right, or any “?” link next to the thing you're looking at.</p>
    <nav class="toc" aria-label="Help topics">${toc}</nav>
  </div>
${body}
</main>
<footer>
  <div class="wrap">
    <p>Wave Exit is open source under the MIT license. <a href="https://github.com/turbogizzmo/wave-exit">Source on GitHub</a>.</p>
    <p>Wave Exit is not affiliated with, endorsed by or sponsored by Wave Financial Inc. "Wave" is used only to describe the books it converts. QuickBooks and Xero are trademarks of their respective owners.</p>
  </div>
</footer>
</body>
</html>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(join(SITE, "help.html"), helpHtml());
  console.log("wrote site/help.html");
}
