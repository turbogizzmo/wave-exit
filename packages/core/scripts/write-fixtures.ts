// Writes the synthetic fixture business to test/fixtures/synthetic/ as the files a
// user would drop into Wave Exit: Wave's two export ZIPs and a Wave API snapshot.
// Run with: npm run fixtures (from packages/core). Tests check these stay current.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { snapshot } from "../test/helpers.ts";
import { receiptsZip, transactionsZip } from "../test/fixtures/synthetic.ts";

const dir = join(import.meta.dirname, "..", "test", "fixtures", "synthetic");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "transactions-export.zip"), transactionsZip());
writeFileSync(join(dir, "receipts-export.zip"), receiptsZip());
writeFileSync(join(dir, "wave-snapshot.json"), JSON.stringify(await snapshot(), null, 2) + "\n");
console.log(`wrote fixtures to ${dir}`);
