/**
 * Minimal 5-field cron matching (minute hour day-of-month month day-of-week)
 * supporting *, numbers, lists, ranges, and steps — enough for the schedule
 * expressions this app accepts. Matching is at minute granularity.
 */

function matchField(field: string, value: number, isDow = false): boolean {
  return field.split(',').some((part) => {
    const [rangePart, stepStr] = part.split('/');
    const step = stepStr ? Number(stepStr) : 1;
    if (!Number.isFinite(step) || step < 1) return false;
    const values = isDow && value === 0 ? [0, 7] : [value];
    if (rangePart === '*') return values.some((v) => v % step === 0);
    if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return values.some((v) => v >= a && v <= b && (v - a) % step === 0);
    }
    const n = Number(rangePart);
    if (!Number.isFinite(n)) return false;
    return values.some((v) => (stepStr ? v >= n && (v - n) % step === 0 : v === n));
  });
}

export function cronMatches(expr: string, d: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return (
    matchField(fields[0], d.getMinutes()) &&
    matchField(fields[1], d.getHours()) &&
    matchField(fields[2], d.getDate()) &&
    matchField(fields[3], d.getMonth() + 1) &&
    matchField(fields[4], d.getDay(), true)
  );
}

const MINUTE = 60_000;
const floorToMinute = (t: number) => t - (t % MINUTE);

/** Most recent scheduled occurrence at or before `now`, or null. */
export function lastDue(expr: string, now: number, lookbackMinutes = 48 * 60): number | null {
  const start = floorToMinute(now);
  for (let m = 0; m <= lookbackMinutes; m++) {
    const t = start - m * MINUTE;
    if (cronMatches(expr, new Date(t))) return t;
  }
  return null;
}

/** Next scheduled occurrence strictly after `now`, or null. */
export function nextDue(expr: string, now: number, lookaheadMinutes = 48 * 60): number | null {
  const start = floorToMinute(now) + MINUTE;
  for (let m = 0; m <= lookaheadMinutes; m++) {
    const t = start + m * MINUTE;
    if (cronMatches(expr, new Date(t))) return t;
  }
  return null;
}
