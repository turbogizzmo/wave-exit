import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { receiptsZip, transactionsZip } from "./fixtures/synthetic.ts";
import { snapshot } from "./helpers.ts";

const dir = join(import.meta.dirname, "fixtures", "synthetic");

describe("committed fixture files", () => {
  it("match the generator (run `npm run fixtures` after changing it)", async () => {
    expect(new Uint8Array(readFileSync(join(dir, "transactions-export.zip")))).toEqual(transactionsZip());
    expect(new Uint8Array(readFileSync(join(dir, "receipts-export.zip")))).toEqual(receiptsZip());
    expect(JSON.parse(readFileSync(join(dir, "wave-snapshot.json"), "utf8"))).toEqual(await snapshot());
  });
});
