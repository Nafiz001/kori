/**
 * Money.
 *
 * The first decision in a ledger, and the one that is hardest to undo later, is
 * how to represent an amount. kori uses **integer minor units** — poisha, not
 * taka; cents, not dollars — held in a `bigint`.
 *
 * Floating point is not an option, and the reason is not pedantry. IEEE-754
 * doubles cannot represent 0.1 exactly, so `0.1 + 0.2 === 0.30000000000000004`.
 * In a ledger that means a sequence of correct-looking operations leaves the
 * books unbalanced by a fraction of a poisha, and the discrepancy compounds
 * silently until someone reconciles by hand.
 *
 * `bigint` rather than `number` is a smaller decision but the same kind. A JS
 * number is exact only up to 2^53 minor units — around 90 trillion taka, which
 * is genuinely enough — but "enough" is a bad property for money to have, and
 * PostgreSQL's `bigint` maps onto it exactly, so nothing is lost at the
 * boundary.
 *
 * Currencies differ in how many minor units they have, which is why the scale
 * is data rather than a hardcoded 100. BDT and USD have two decimal places,
 * JPY has none, and KWD has three.
 */

export type CurrencyCode = "BDT" | "USD" | "EUR" | "JPY" | "KWD";

export interface Currency {
  readonly code: CurrencyCode;
  /** How many decimal places the currency has. BDT 2, JPY 0, KWD 3. */
  readonly scale: number;
  readonly name: string;
}

export const CURRENCIES: Readonly<Record<CurrencyCode, Currency>> = {
  BDT: { code: "BDT", scale: 2, name: "Bangladeshi Taka" },
  USD: { code: "USD", scale: 2, name: "US Dollar" },
  EUR: { code: "EUR", scale: 2, name: "Euro" },
  JPY: { code: "JPY", scale: 0, name: "Japanese Yen" },
  KWD: { code: "KWD", scale: 3, name: "Kuwaiti Dinar" },
};

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.hasOwn(CURRENCIES, value);
}

export function currencyOf(code: CurrencyCode): Currency {
  const currency = CURRENCIES[code];
  if (!currency) throw new MoneyError(`unknown currency: ${code}`);
  return currency;
}

export class MoneyError extends Error {
  override readonly name = "MoneyError";
}

/**
 * An amount in a specific currency.
 *
 * `minor` is the whole number of minor units: 12.34 BDT is 1234n. It may be
 * negative — a ledger entry is a signed amount, and forbidding negatives here
 * would push the sign into a separate field where it is easier to lose.
 */
export interface Money {
  readonly currency: CurrencyCode;
  readonly minor: bigint;
}

export function money(currency: CurrencyCode, minor: bigint): Money {
  if (!isCurrencyCode(currency)) throw new MoneyError(`unknown currency: ${currency}`);
  return { currency, minor };
}

export function zero(currency: CurrencyCode): Money {
  return money(currency, 0n);
}

/**
 * Arithmetic refuses to mix currencies.
 *
 * Adding taka to dollars is never a rounding question, it is always a bug, and
 * the only useful thing to do with it is stop. A ledger that silently treats
 * currencies as interchangeable produces books that balance and mean nothing.
 */
function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`cannot combine ${a.currency} and ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { currency: a.currency, minor: a.minor + b.minor };
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { currency: a.currency, minor: a.minor - b.minor };
}

export function negate(a: Money): Money {
  return { currency: a.currency, minor: -a.minor };
}

export function isZero(a: Money): boolean {
  return a.minor === 0n;
}

export function isNegative(a: Money): boolean {
  return a.minor < 0n;
}

export function isPositive(a: Money): boolean {
  return a.minor > 0n;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  if (a.minor < b.minor) return -1;
  if (a.minor > b.minor) return 1;
  return 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minor === b.minor;
}

/**
 * Sum a list, which needs the currency stated because an empty list has no
 * currency of its own to report.
 */
export function sum(currency: CurrencyCode, amounts: readonly Money[]): Money {
  let total = 0n;
  for (const amount of amounts) {
    if (amount.currency !== currency) {
      throw new MoneyError(`cannot sum ${amount.currency} into ${currency}`);
    }
    total += amount.minor;
  }
  return { currency, minor: total };
}

/**
 * Split an amount into `parts` as evenly as possible, distributing the
 * remainder one minor unit at a time.
 *
 * The point is that nothing is lost. Splitting 100 poisha three ways gives
 * 34, 33, 33 — not three lots of 33.33 that quietly discard a poisha. Any
 * allocation that does not sum back to the original is a leak, and in a ledger
 * a leak is an imbalance.
 */
export function allocate(amount: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new MoneyError(`parts must be a positive integer, got ${parts}`);
  }

  const divisor = BigInt(parts);
  const base = amount.minor / divisor;
  // Remainder takes the sign of the dividend in both JS and SQL, so a negative
  // amount distributes its remainder downward rather than upward.
  let remainder = amount.minor - base * divisor;
  const step = remainder < 0n ? -1n : 1n;

  const out: Money[] = [];
  for (let i = 0; i < parts; i++) {
    let share = base;
    if (remainder !== 0n) {
      share += step;
      remainder -= step;
    }
    out.push({ currency: amount.currency, minor: share });
  }
  return out;
}

/**
 * Apply a rate given as a numerator and denominator — 25/1000 for 2.5% — and
 * round half away from zero.
 *
 * The rate is a ratio rather than a float on purpose. Writing `amount * 0.025`
 * reintroduces exactly the representation error that integer minor units were
 * chosen to avoid, and a fee is precisely where that error would be noticed.
 */
export function applyRate(amount: Money, numerator: bigint, denominator: bigint): Money {
  if (denominator === 0n) throw new MoneyError("rate denominator cannot be zero");

  const product = amount.minor * numerator;
  const quotient = product / denominator;
  const remainder = product % denominator;

  // Round half away from zero, which is what people expect of money and what
  // most financial regulation specifies.
  const twiceRemainder = (remainder < 0n ? -remainder : remainder) * 2n;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  let rounded = quotient;
  if (twiceRemainder >= absDenominator) {
    rounded += product < 0n ? -1n : 1n;
  }

  return { currency: amount.currency, minor: rounded };
}

/**
 * Parse a decimal string into minor units: "12.34" BDT becomes 1234n.
 *
 * Strings, not numbers, are the input. Accepting a JS number here would mean
 * the value had already been through a double before kori ever saw it, and no
 * amount of care afterwards can recover what that lost.
 */
export function parseAmount(currency: CurrencyCode, text: string): Money {
  const { scale } = currencyOf(currency);

  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) throw new MoneyError(`not a valid amount: ${JSON.stringify(text)}`);

  const [, sign, whole, fraction = ""] = match as unknown as [string, string, string, string?];

  if (fraction.length > scale) {
    throw new MoneyError(
      `${currency} has ${scale} decimal place(s); ${JSON.stringify(text)} has ${fraction.length}`,
    );
  }

  const padded = fraction.padEnd(scale, "0");
  const minor = BigInt(whole + padded);
  return { currency, minor: sign === "-" ? -minor : minor };
}

/** Format minor units back to a decimal string: 1234n BDT becomes "12.34". */
export function formatAmount(amount: Money): string {
  const { scale } = currencyOf(amount.currency);
  const negative = amount.minor < 0n;
  const digits = (negative ? -amount.minor : amount.minor).toString();

  if (scale === 0) return negative ? `-${digits}` : digits;

  const padded = digits.padStart(scale + 1, "0");
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** The shape money takes in a JSON response. */
export interface MoneyJSON {
  readonly currency: CurrencyCode;
  /** Decimal string, for humans: "12.34". */
  readonly amount: string;
  /**
   * Minor units, as a string.
   *
   * A string rather than a number because JSON numbers are doubles in every
   * mainstream parser, so a large balance would lose precision on the way into
   * a client that did nothing wrong. Clients that care read this field.
   */
  readonly minor: string;
}

export function toJSON(amount: Money): MoneyJSON {
  return {
    currency: amount.currency,
    amount: formatAmount(amount),
    minor: amount.minor.toString(),
  };
}
