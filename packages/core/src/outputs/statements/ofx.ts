/**
 * OFX 1.0.2 (SGML) statement writer: the format banks give for "Download to
 * Quicken / QuickBooks / Money", and the one Xero recommends. Element rules from
 * the OFX 2.3 specification (10/16/2020): NAME A-32, MEMO A-255 (V1 message sets),
 * FITID A-255 and unique per account, CHECKNUM A-12, ACCTID A-22, BANKID A-9;
 * amounts signed from the customer's side (a card purchase is negative, a card
 * payment positive); dates YYYYMMDD[HHMMSS].
 *
 * The .qbo (QuickBooks Web Connect) and .qfx (Quicken) variants add <INTU.BID>
 * to the sign-on block, which those programs check against Intuit's list of
 * banks. Intuit doesn't publish that list, so the ID must be supplied.
 */

export interface StatementLine {
  fitid: string;
  date: string;
  /** Minor units, customer's side: money in (or a card payment) positive. */
  amount: bigint;
  type: "CREDIT" | "DEBIT" | "XFER";
  name: string;
  memo: string;
  checkNumber?: string;
}

export interface Statement {
  kind: "bank" | "creditCard";
  /** Synthetic but stable account number (A-22). */
  accountId: string;
  bankId: string;
  accountType: "CHECKING" | "SAVINGS";
  currency: string;
  exponent: number;
  start: string;
  end: string;
  /** Balance at `end`, customer's side. */
  ledgerBalance: bigint;
  lines: StatementLine[];
}

export interface OfxOptions {
  /** Server date in the sign-on block. */
  created: Date;
  /** Intuit bank ID for .qbo / .qfx files. */
  intuitBid?: string;
  org?: string;
  fid?: string;
}

const dt = (iso: string) => `${iso.replaceAll("-", "")}120000`;

/** SGML text: no markup characters, WinAnsi-safe, trimmed to the element's length. */
export function ofxText(s: string, max: number): string {
  const clean = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[<>&]/g, (c) => ({ "<": "(", ">": ")", "&": "and" })[c]!)
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? clean.slice(0, max).trimEnd() : clean;
}

export function ofxAmount(v: bigint, exponent: number): string {
  const neg = v < 0n;
  const a = (neg ? -v : v).toString().padStart(exponent + 1, "0");
  return `${neg ? "-" : ""}${exponent ? `${a.slice(0, -exponent)}.${a.slice(-exponent)}` : a}`;
}

export function writeOfx(st: Statement, opts: OfxOptions): string {
  const server = opts.created.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const lines: string[] = [
    "OFXHEADER:100", "DATA:OFXSGML", "VERSION:102", "SECURITY:NONE", "ENCODING:USASCII", "CHARSET:1252",
    "COMPRESSION:NONE", "OLDFILEUID:NONE", "NEWFILEUID:NONE", "",
    "<OFX>", "<SIGNONMSGSRSV1>", "<SONRS>", "<STATUS>", "<CODE>0", "<SEVERITY>INFO", "</STATUS>",
    `<DTSERVER>${server}`, "<LANGUAGE>ENG",
  ];
  if (opts.org || opts.fid) lines.push("<FI>", `<ORG>${ofxText(opts.org ?? "", 32)}`, `<FID>${ofxText(opts.fid ?? "", 32)}`, "</FI>");
  if (opts.intuitBid) lines.push(`<INTU.BID>${ofxText(opts.intuitBid, 32)}`);
  lines.push("</SONRS>", "</SIGNONMSGSRSV1>");
  const cc = st.kind === "creditCard";
  lines.push(cc ? "<CREDITCARDMSGSRSV1>" : "<BANKMSGSRSV1>", cc ? "<CCSTMTTRNRS>" : "<STMTTRNRS>", "<TRNUID>1",
    "<STATUS>", "<CODE>0", "<SEVERITY>INFO", "</STATUS>", cc ? "<CCSTMTRS>" : "<STMTRS>", `<CURDEF>${st.currency || "USD"}`);
  if (cc) lines.push("<CCACCTFROM>", `<ACCTID>${ofxText(st.accountId, 22)}`, "</CCACCTFROM>");
  else lines.push("<BANKACCTFROM>", `<BANKID>${ofxText(st.bankId, 9)}`, `<ACCTID>${ofxText(st.accountId, 22)}`, `<ACCTTYPE>${st.accountType}`, "</BANKACCTFROM>");
  lines.push("<BANKTRANLIST>", `<DTSTART>${dt(st.start)}`, `<DTEND>${dt(st.end)}`);
  for (const t of st.lines) {
    lines.push("<STMTTRN>", `<TRNTYPE>${t.type}`, `<DTPOSTED>${dt(t.date)}`, `<TRNAMT>${ofxAmount(t.amount, st.exponent)}`, `<FITID>${ofxText(t.fitid, 255)}`);
    if (t.checkNumber) lines.push(`<CHECKNUM>${ofxText(t.checkNumber, 12)}`);
    lines.push(`<NAME>${ofxText(t.name, 32) || "Transaction"}`);
    const memo = ofxText(t.memo, 255);
    if (memo) lines.push(`<MEMO>${memo}`);
    lines.push("</STMTTRN>");
  }
  lines.push("</BANKTRANLIST>", "<LEDGERBAL>", `<BALAMT>${ofxAmount(st.ledgerBalance, st.exponent)}`, `<DTASOF>${dt(st.end)}`, "</LEDGERBAL>",
    cc ? "</CCSTMTRS>" : "</STMTRS>", cc ? "</CCSTMTTRNRS>" : "</STMTTRNRS>", cc ? "</CREDITCARDMSGSRSV1>" : "</BANKMSGSRSV1>", "</OFX>");
  return lines.join("\r\n") + "\r\n";
}
