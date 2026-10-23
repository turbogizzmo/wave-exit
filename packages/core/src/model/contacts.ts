import type { ContactRow, LedgerRow } from "../readers/transactions-export.ts";
import type { SnapContact, WaveSnapshot } from "../readers/wave-api/snapshot.ts";
import { normalizeName } from "./names.ts";
import type { Contact } from "./types.ts";

/**
 * Customers and vendors from Wave (with IDs), the export's customers.csv and
 * vendors.csv (names only), and any names that appear only on ledger lines.
 * The export and ledger refer to contacts by name, so names are the join key.
 */
export interface ContactResolution {
  contacts: Contact[];
  /** `customer|<name>` / `vendor|<name>` → contact ID. */
  byName: Map<string, string>;
}

export function resolveContacts(
  ledger: readonly LedgerRow[],
  exportCustomers: readonly ContactRow[],
  exportVendors: readonly ContactRow[],
  snapshot: WaveSnapshot | undefined,
): ContactResolution {
  const contacts = new Map<string, Contact>();
  const byName = new Map<string, string>();

  const build = (role: "customer" | "vendor", wave: readonly SnapContact[], rows: readonly ContactRow[], ledgerNames: Iterable<string>) => {
    const exact = new Map<string, SnapContact>();
    const norm = new Map<string, SnapContact>();
    for (const w of wave) {
      if (!exact.has(w.name)) exact.set(w.name, w);
      const n = normalizeName(w.name);
      if (!norm.has(n)) norm.set(n, w);
      const id = `wave:${w.id}`;
      contacts.set(id, fromWave(role, w));
    }
    const rowByName = new Map(rows.map((r) => [r.name, r] as const));
    const names = new Set([...rows.map((r) => r.name), ...ledgerNames]);
    for (const name of names) {
      const w = exact.get(name) ?? norm.get(normalizeName(name));
      let id: string;
      if (w) {
        id = `wave:${w.id}`;
      } else {
        id = `export-${role}:${normalizeName(name) || name}`;
        if (!contacts.has(id)) contacts.set(id, fromExport(role, name, rowByName.get(name)));
      }
      byName.set(`${role}|${name}`, id);
    }
  };

  build("customer", snapshot?.customers ?? [], exportCustomers, ledger.map((r) => r.customer).filter(Boolean));
  build("vendor", snapshot?.vendors ?? [], exportVendors, ledger.map((r) => r.vendor).filter(Boolean));

  const list = [...contacts.values()].sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { contacts: list, byName };
}

function fromWave(role: "customer" | "vendor", w: SnapContact): Contact {
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    firstName: w.firstName, lastName: w.lastName, displayId: w.displayId, mobile: w.mobile, fax: w.fax,
    tollFree: w.tollFree, website: w.website,
    shippingName: w.shipping?.name ?? "", shippingPhone: w.shipping?.phone ?? "", shippingInstructions: w.shipping?.instructions ?? "",
  })) if (v) extra[k] = v;
  return {
    id: `wave:${w.id}`,
    role,
    name: w.name,
    waveId: w.id,
    email: w.email,
    phone: w.phone,
    currency: w.currency,
    isArchived: w.isArchived,
    address: w.address
      ? { line1: w.address.line1, line2: w.address.line2, city: w.address.city, province: w.address.province, postalCode: w.address.postalCode, country: w.address.country }
      : null,
    extra,
  };
}

function fromExport(role: "customer" | "vendor", name: string, row: ContactRow | undefined): Contact {
  const f = row?.fields ?? {};
  const g = (k: string) => (f[k] ?? "").trim();
  const hasAddress = ["address_line_1", "city", "country", "postal_code/zip_code"].some((k) => g(k));
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) if (v.trim() && !["email", `${role}_name`, `${role}_currency`, "phone"].includes(k)) extra[k] = v.trim();
  return {
    id: `export-${role}:${normalizeName(name) || name}`,
    role,
    name,
    waveId: "",
    email: row?.email ?? "",
    phone: g("phone"),
    currency: row?.currency ?? "",
    isArchived: false,
    address: hasAddress
      ? { line1: g("address_line_1"), line2: g("address_line_2"), city: g("city"), province: g("province/state"), postalCode: g("postal_code/zip_code"), country: g("country") }
      : null,
    extra,
  };
}
