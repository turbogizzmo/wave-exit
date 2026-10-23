import { describe, expect, it } from "vitest";
import { classify, DEFAULT_RULES, type EntryShape, type Role } from "../src/index.ts";

/** Build a shape from "role:D100" / "role:C100" terms (amounts in cents). */
function shape(terms: string[], flags: Partial<Pick<EntryShape, "hasInvoiceNumber" | "hasBillNumber" | "hasCustomer">> = {}): EntryShape {
  const roleCounts = new Map<Role, number>();
  const roleNet = new Map<Role, bigint>();
  for (const t of terms) {
    const [role, amt] = t.split(":") as [Role, string];
    const v = BigInt(amt.slice(1)) * (amt[0] === "D" ? 1n : -1n);
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    roleNet.set(role, (roleNet.get(role) ?? 0n) + v);
  }
  return { roleCounts, roleNet, hasInvoiceNumber: false, hasBillNumber: false, hasCustomer: false, ...flags };
}
const type = (terms: string[], flags?: Parameters<typeof shape>[1]) => classify(DEFAULT_RULES, shape(terms, flags)).type;

describe("default classification table", () => {
  it.each([
    [["bank:C10", "expense:D10"], {}, "expense"],
    [["creditCard:C10", "expense:D6", "expense:D4"], {}, "expense"],
    [["creditCard:D10", "expense:C10"], {}, "refund"],
    [["bank:D10", "income:C10"], {}, "deposit"],
    [["bank:D10", "income:C10"], { hasCustomer: true }, "sales-receipt"],
    [["bank:D10", "income:C8", "otherAsset:C2"], {}, "deposit"],
    [["bank:C10", "bank:D10"], {}, "transfer"],
    [["bank:C10", "creditCard:D10"], {}, "credit-card-payment"],
    [["bank:C10", "transferClearing:D10"], {}, "transfer-leg"],
    [["creditCard:D10", "transferClearing:C10"], {}, "transfer-leg"],
    [["receivable:D10", "income:C10"], { hasInvoiceNumber: true }, "invoice"],
    [["receivable:D9", "income:C10", "income:D1"], { hasInvoiceNumber: true }, "invoice"],
    [["receivable:D11", "income:C10", "salesTax:C1"], { hasInvoiceNumber: true }, "invoice"],
    [["bank:D10", "receivable:C10"], { hasInvoiceNumber: true }, "invoice-payment"],
    [["bank:D9", "expense:D1", "receivable:C10"], { hasInvoiceNumber: true }, "invoice-payment"],
    [["payable:C10", "expense:D10"], { hasBillNumber: true }, "bill"],
    [["payable:D10", "bank:C10"], { hasBillNumber: true }, "bill-payment"],
    [["bank:D10", "equity:C10"], {}, "journal"],
    [["receivable:C10", "income:D10"], {}, "journal"],
    [["receivable:D10", "income:C10"], {}, "journal"], // no invoice number
    [["bank:C10", "bank:C5", "expense:D15"], {}, "journal"], // two money accounts
  ] as const)("%j %j → %s", (terms, flags, expected) => {
    expect(type([...terms], flags)).toBe(expected);
  });

  it("every rule explains itself", () => {
    for (const r of DEFAULT_RULES) expect(r.why.length).toBeGreaterThan(20);
  });
});
