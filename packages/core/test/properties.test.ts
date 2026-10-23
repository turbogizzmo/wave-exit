import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildBooks, readTransactionsExport, sum } from "../src/index.ts";
import { ACCOUNTS, accountingCsv, transactionsZip, type FxEntry } from "./fixtures/synthetic.ts";

/**
 * Property tests: random balanced ledgers written in Wave's export format go
 * through the reader and the model without losing a line or a cent, every entry
 * balances, and classification is total.
 */
const keys = ACCOUNTS.filter((a) => !a.key.endsWith("Dup") && !/^(ar|tc)\d$/.test(a.key) && a.key !== "arOther").map((a) => a.key).concat(["ar", "tc"]);

const entryArb = fc
  .record({
    date: fc.date({ min: new Date("2020-01-01"), max: new Date("2025-12-31"), noInvalidDate: true }),
    amounts: fc.array(fc.integer({ min: 1, max: 5_000_000 }), { minLength: 1, maxLength: 20 }),
    accounts: fc.array(fc.constantFrom(...keys), { minLength: 21, maxLength: 21 }),
    description: fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0 && !/[\r\n]/.test(s)),
  })
  .map(({ date, amounts, accounts, description }): Omit<FxEntry, "id"> => {
    const total = amounts.reduce((s, a) => s + a, 0);
    const c = (n: number) => (n / 100).toFixed(2);
    return {
      date: date.toISOString().slice(0, 10),
      description,
      lines: [...amounts.map((a, i) => ({ account: accounts[i]!, debit: c(a) })), { account: accounts[20]!, credit: c(total) }],
    };
  });

describe("properties", () => {
  it("reading and modelling a balanced ledger keeps every line and every cent", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(entryArb, { minLength: 1, maxLength: 25 }), async (raw) => {
        const entries = raw.map((e, i) => ({ ...e, id: `8${String(i).padStart(18, "0")}` }));
        const tx = await readTransactionsExport([{ path: "x.zip", bytes: transactionsZip({ entries }) }]);
        const lines = entries.reduce((n, e) => n + e.lines.length, 0);
        expect(tx.ledger).toHaveLength(lines);
        const b = buildBooks({ transactions: tx, business: { name: "P", currency: "USD" } });
        expect(b.entries).toHaveLength(entries.length);
        for (const e of b.entries) expect(e.debitTotal).toBe(e.creditTotal);
        const dr = sum(b.entries.map((e) => e.debitTotal));
        const expected = entries.reduce((s, e) => s + BigInt(Math.round(Number(e.lines.at(-1)!.credit) * 100)), 0n);
        expect(dr).toBe(expected);
        expect(b.checks.find((c) => c.id === 1)!.status).toBe("green");
        expect(b.checks.find((c) => c.id === 6)!.status).toBe("green");
        expect(b.entries.every((e) => e.type && e.why)).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  it("the writer used by the fixture produces Wave's one-column sign convention", async () => {
    const tx = await readTransactionsExport([{ path: "x.zip", bytes: transactionsZip() }]);
    expect(tx.notes.filter((n) => n.severity === "warning")).toEqual([]);
    expect(accountingCsv().split("\n")[0]).toContain(", ,");
  });
});
