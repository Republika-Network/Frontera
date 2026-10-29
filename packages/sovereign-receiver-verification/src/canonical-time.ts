/**
 * Canonical UTC timestamps (`aoc-canonical-json/1`, as Protocol's internal
 * `isCanonicalTimestamp` accepts them) as exact instants. Shared by the status
 * verifier and the freshness gate; not exported from the package.
 */
const CANONICAL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

export const NANOS_PER_SECOND = 1_000_000_000n;

/**
 * A canonical UTC timestamp as nanoseconds since the epoch, or `undefined`
 * when the value is not one. Calendar arithmetic only: no Date, so no
 * millisecond rounding and no two-digit-year quirks.
 */
export function canonicalInstant(value: unknown): bigint | undefined {
  if (typeof value !== 'string') return undefined;
  const match = CANONICAL_TIMESTAMP.exec(value);
  if (match === null) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  const seconds = BigInt(daysFromCivil(year, month, day)) * 86_400n + BigInt(hour * 3600 + minute * 60 + second);
  return seconds * NANOS_PER_SECOND + BigInt((match[7] ?? '').padEnd(9, '0'));
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Days since 1970-01-01 in the proleptic Gregorian calendar. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}
