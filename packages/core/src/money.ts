/**
 * Money is held as a bigint count of minor units (cents for USD), never as a float.
 * The number of minor units per major unit comes from the currency's exponent
 * (Wave's `Currency.exponent`): 2 for USD/CAD/EUR, 0 for JPY, 3 for KWD.
 */
export type Minor = bigint;

const PLAIN = /^(-)?(\d+)(?:\.(\d+))?$/;
const GROUPED = /^(-)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/;

export class AmountFormatError extends Error {
  readonly input: string;
  constructor(input: string) {
    super(`Not a plain decimal amount: ${JSON.stringify(input)}`);
    this.input = input;
  }
}

/**
 * Parse a decimal string into minor units. Exact: refuses rather than rounds when
 * the string has more decimal places than the currency allows (unless the extra
 * digits are zeros). `allowGrouping` accepts thousands separators ("1,234.56"),
 * which Wave's `Money.value` uses.
 */
export function parseAmount(input: string, exponent = 2, opts: { allowGrouping?: boolean } = {}): Minor {
  const s = input.trim();
  const m = (opts.allowGrouping ? GROUPED : PLAIN).exec(s);
  if (!m) throw new AmountFormatError(input);
  const [, neg, whole = "0", fracRaw = ""] = m;
  const frac = fracRaw.replace(/0+$/, "");
  if (frac.length > exponent) throw new AmountFormatError(input);
  const digits = whole.replaceAll(",", "") + frac.padEnd(exponent, "0");
  const v = BigInt(digits);
  return neg ? -v : v;
}

/** Parse, treating blank as zero. */
export function parseOptionalAmount(input: string | undefined | null, exponent = 2): Minor {
  if (input == null || input.trim() === "") return 0n;
  return parseAmount(input, exponent);
}

/** Plain machine format: "-1234.50". Used in every output file. */
export function formatPlain(v: Minor, exponent = 2): string {
  const neg = v < 0n;
  const abs = (neg ? -v : v).toString().padStart(exponent + 1, "0");
  const whole = exponent ? abs.slice(0, -exponent) : abs;
  const frac = exponent ? "." + abs.slice(-exponent) : "";
  return (neg ? "-" : "") + whole + frac;
}

/** Accountant display format: thousands separators, negatives in parentheses. */
export function formatDisplay(v: Minor, exponent = 2): string {
  const plain = formatPlain(v < 0n ? -v : v, exponent);
  const [whole = "0", frac] = plain.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const s = frac === undefined ? grouped : `${grouped}.${frac}`;
  return v < 0n ? `(${s})` : s;
}

export function sum(values: Iterable<Minor>): Minor {
  let t = 0n;
  for (const v of values) t += v;
  return t;
}

export const abs = (v: Minor): Minor => (v < 0n ? -v : v);
