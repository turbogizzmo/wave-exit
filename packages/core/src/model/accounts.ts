import { parseAmount, sum, type Minor } from "../money.ts";
import type { LedgerRow } from "../readers/transactions-export.ts";
import type { SnapAccount, WaveSnapshot } from "../readers/wave-api/snapshot.ts";
import { normalizeName } from "./names.ts";
import { GROUP_TO_TYPE, normalBalanceOf, roleOf, SubtypeCatalogue, TYPE_TO_GROUP, type WaveAccountType } from "./subtypes.ts";
import type { Account, Issue } from "./types.ts";

/**
 * Builds the chart of accounts and maps every export account (known by name only)
 * to it. Connected: the chart is Wave's full chart (active and archived), and the
 * export's names are matched to it. Export-file-only: the chart is the accounts
 * that appear in the export, with subtypes inferred from `Account Type`.
 */

export interface AccountResolution {
  accounts: Account[];
  /** Export key (see exportKey) → account ID. */
  byExportKey: Map<string, string>;
  issues: Issue[];
}

export const exportKey = (r: Pick<LedgerRow, "accountGroup" | "accountType" | "accountName">): string =>
  `${r.accountGroup}|${r.accountType}|${r.accountName}`;

export function resolveAccounts(
  ledger: readonly LedgerRow[],
  snapshot: WaveSnapshot | undefined,
  resolutions: Record<string, string>,
  exponent: number,
): AccountResolution {
  const catalogue = new SubtypeCatalogue(
    (snapshot?.accountSubtypes ?? []).map((s) => ({ value: s.value, name: s.name, type: s.type as WaveAccountType, systemCreated: s.systemCreated })),
  );
  const issues: Issue[] = [];
  const accounts = new Map<string, Account>();
  const byExportKey = new Map<string, string>();
  /** Wave account ID → model account ID it was merged into. */
  const mergedInto = new Map<string, string>();

  // Distinct export accounts, with their line counts.
  const exportAccounts = new Map<string, { row: LedgerRow; lines: number }>();
  for (const r of ledger) {
    const k = exportKey(r);
    const e = exportAccounts.get(k);
    if (e) e.lines++;
    else exportAccounts.set(k, { row: r, lines: 1 });
  }

  // Wave's chart, when connected. Each Wave account becomes one model account,
  // except identical system accounts, which are merged below on first use.
  const waveById = new Map<string, SnapAccount>();
  if (snapshot) {
    for (const a of snapshot.accounts) {
      waveById.set(a.id, a);
      accounts.set(`wave:${a.id}`, fromWave(a, catalogue, exponent));
    }
  }

  for (const [key, { row, lines }] of exportAccounts) {
    const type = GROUP_TO_TYPE[row.accountGroup];
    const sub = catalogue.forExport(row.accountGroup, row.accountType);
    if (!sub) {
      issues.push({
        id: `unknown-account-type:${key}`,
        kind: "unknown-account-type",
        severity: "amber",
        title: `Unfamiliar account type "${row.accountType}"`,
        explanation: `The account "${row.accountName}" has the type "${row.accountType}", which Wave Exit hasn't seen before. It is treated as a general ${row.accountGroup.toLowerCase()} account. Check how it comes out in the outputs.`,
        options: [],
        refs: [key],
      });
    }

    if (!snapshot) {
      const id = `export:${key}`;
      accounts.set(id, fromExport(row, sub?.value ?? "", sub?.systemCreated ?? false, lines));
      byExportKey.set(key, id);
      continue;
    }

    const candidates = matchByName(snapshot.accounts, row.accountName).filter((a) => a.type === type);
    const narrowed = sub ? candidates.filter((a) => a.subtype === sub.value) : candidates;
    const pool = narrowed.length ? narrowed : candidates;

    if (pool.length === 0) {
      const id = `export:${key}`;
      accounts.set(id, fromExport(row, sub?.value ?? "", sub?.systemCreated ?? false, lines));
      byExportKey.set(key, id);
      issues.push({
        id: `account-not-in-wave:${key}`,
        kind: "account-not-in-wave",
        severity: "amber",
        title: `"${row.accountName}" isn't in the connected business's chart of accounts`,
        explanation: `The export uses an account called "${row.accountName}" (${row.accountType}) that Wave's chart for this business doesn't have. It may have been renamed or deleted since the export, or the export may be from a different business. It is kept as its own account.`,
        options: [],
        refs: [key],
      });
      continue;
    }

    let chosen: SnapAccount[];
    const answer = resolutions[`ambiguous-account:${key}`];
    if (pool.length === 1) {
      chosen = pool;
    } else if (pool.every((a) => a.subtype === pool[0]!.subtype) && (sub?.systemCreated ?? isSystemSubtype(catalogue, pool[0]!))) {
      // Wave system accounts (Transfer Clearing, Accounts Receivable…): identical, merge.
      chosen = pool;
    } else if (answer && pool.some((a) => a.id === answer)) {
      chosen = pool.filter((a) => a.id === answer);
    } else {
      const nonZero = pool.filter((a) => parseAmount(a.balance, exponent) !== 0n);
      if (nonZero.length === 1) {
        chosen = nonZero;
      } else {
        chosen = [pool[0]!];
        issues.push({
          id: `ambiguous-account:${key}`,
          kind: "ambiguous-account",
          severity: "red",
          title: `${pool.length} accounts are named "${row.accountName}"`,
          explanation: `Wave has ${pool.length} ${row.accountType} accounts called "${row.accountName}", and the export names accounts only by name. Which one do these ${lines} lines belong to?`,
          options: pool.map((a) => ({
            value: a.id,
            label: `${a.name}${a.displayId ? ` (${a.displayId})` : ""}${a.isArchived ? ", archived" : ""}, Wave balance ${a.balance}`,
          })),
          refs: [key],
        });
      }
    }

    const id = mergedInto.get(chosen[0]!.id) ?? `wave:${chosen[0]!.id}`;
    if (chosen.length > 1 && !mergedInto.has(chosen[0]!.id)) {
      const merged = accounts.get(id)!;
      merged.waveIds = chosen.map((a) => a.id);
      merged.waveBalance = sum(chosen.map((a) => parseAmount(a.balance, exponent)));
      merged.isArchived = chosen.every((a) => a.isArchived);
      for (const a of chosen) mergedInto.set(a.id, id);
      for (const a of chosen.slice(1)) accounts.delete(`wave:${a.id}`);
    }
    accounts.get(id)!.lineCount += lines;
    byExportKey.set(key, id);
  }

  // Fold any other identical system accounts with no activity into the merged one,
  // so the chart doesn't carry 30 empty "Transfer Clearing" accounts.
  const mergedTargets = [...accounts.values()].filter((a) => a.waveIds.length > 1);
  for (const target of mergedTargets) {
    for (const [id, a] of accounts) {
      if (a === target || a.lineCount > 0 || a.name !== target.name || a.subtype !== target.subtype) continue;
      if (a.waveBalance !== 0n) continue;
      target.waveIds.push(...a.waveIds);
      accounts.delete(id);
    }
  }

  const list = [...accounts.values()].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { accounts: list, byExportKey, issues };
}

function isSystemSubtype(catalogue: SubtypeCatalogue, a: SnapAccount): boolean {
  return catalogue.byTypeAndValue(a.type, a.subtype)?.systemCreated ?? false;
}

function matchByName(all: readonly SnapAccount[], name: string): SnapAccount[] {
  const exact = all.filter((a) => a.name === name);
  if (exact.length) return exact;
  const n = normalizeName(name);
  return all.filter((a) => normalizeName(a.name) === n);
}

function fromWave(a: SnapAccount, catalogue: SubtypeCatalogue, exponent: number): Account {
  const type = (a.type || "ASSET") as WaveAccountType;
  const info = catalogue.byTypeAndValue(type, a.subtype);
  return {
    id: `wave:${a.id}`,
    name: a.name,
    group: TYPE_TO_GROUP[type],
    type,
    subtype: a.subtype,
    subtypeName: info?.name ?? a.subtypeName,
    normalBalance: a.normalBalance,
    role: roleOf(type, a.subtype),
    displayId: a.displayId,
    description: a.description,
    currency: a.currency,
    isArchived: a.isArchived,
    isSystem: info?.systemCreated ?? false,
    waveIds: [a.id],
    waveBalance: parseAmount(a.balance, exponent) as Minor,
    lineCount: 0,
  };
}

function fromExport(r: LedgerRow, subtype: string, isSystem: boolean, lines: number): Account {
  const type = GROUP_TO_TYPE[r.accountGroup];
  return {
    id: `export:${exportKey(r)}`,
    name: r.accountName,
    group: r.accountGroup,
    type,
    subtype,
    subtypeName: r.accountType,
    normalBalance: normalBalanceOf(type),
    role: roleOf(type, subtype),
    displayId: "",
    description: "",
    currency: "",
    isArchived: false,
    isSystem,
    waveIds: [],
    lineCount: lines,
  };
}
