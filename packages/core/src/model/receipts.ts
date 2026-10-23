import type { ReceiptFile } from "../readers/receipts-export.ts";
import type { Entry, Issue, ReceiptLink } from "./types.ts";

/**
 * Link receipt files to entries. Wave's receipt file names carry the transaction
 * date and its description, but no Transaction ID, so the match is on date +
 * description (spaces, case and punctuation ignored, since file names can't carry
 * every character). A unique match links; several or none become a Review card.
 */
export function linkReceipts(receipts: readonly ReceiptFile[], entries: Entry[], resolutions: Record<string, string>): { links: ReceiptLink[]; issues: Issue[] } {
  const key = (date: string, text: string) => `${date}|${squash(text)}`;
  const byKey = new Map<string, Entry[]>();
  const byDate = new Map<string, Entry[]>();
  for (const e of entries) {
    const k = key(e.date, e.description);
    byKey.set(k, [...(byKey.get(k) ?? []), e]);
    byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
  }
  const byId = new Map(entries.map((e) => [e.id, e] as const));
  const links: ReceiptLink[] = [];
  const issues: Issue[] = [];

  for (const r of receipts) {
    const issueId = `receipt:${r.sha256.slice(0, 16)}:${r.fileName}`;
    const answer = resolutions[issueId];
    let candidates = r.date ? (byKey.get(key(r.date, r.description)) ?? []) : [];
    if (!candidates.length && r.date) {
      // A file name may be cut short, or the description edited later: accept one
      // that starts with the other.
      const s = squash(r.description);
      candidates = (byDate.get(r.date) ?? []).filter((e) => {
        const d = squash(e.description);
        return s.length >= 6 && d.length >= 6 && (d.startsWith(s) || s.startsWith(d));
      });
    }
    const link: ReceiptLink = { fileName: r.fileName, sha256: r.sha256, bytes: r.bytes, entryId: "", status: "unmatched", candidates: candidates.map((c) => c.id) };
    if (answer && byId.has(answer)) {
      link.entryId = answer;
      link.status = "linked";
    } else if (candidates.length === 1) {
      link.entryId = candidates[0]!.id;
      link.status = "linked";
    } else {
      link.status = candidates.length ? "ambiguous" : "unmatched";
      const options = (candidates.length ? candidates : (byDate.get(r.date) ?? [])).slice(0, 20).map((c) => ({ value: c.id, label: `${c.date}: ${c.description}` }));
      issues.push({
        id: issueId,
        kind: candidates.length ? "receipt-ambiguous" : "receipt-unmatched",
        severity: "amber",
        title: candidates.length ? `Receipt "${r.fileName}" fits ${candidates.length} transactions` : `Receipt "${r.fileName}" doesn't match a transaction`,
        explanation: candidates.length
          ? `Several transactions on ${r.date} have the description on this receipt. Which one is it for?`
          : `No transaction${r.date ? ` on ${r.date}` : ""} has the description on this receipt. Pick one, or keep the receipt as an unlinked attachment.`,
        options: [...options, { value: "unlinked", label: "Keep as an unlinked attachment" }],
        refs: candidates.map((c) => c.id),
      });
    }
    if (link.entryId) byId.get(link.entryId)!.attachments.push(r.fileName);
    links.push(link);
  }
  return { links, issues };
}

const squash = (s: string) => s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
