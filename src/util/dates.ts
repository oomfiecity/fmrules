/**
 * Date-boundary helpers shared by the compile-side rule filter emitter
 * (src/compile/emit-filter.ts) and the live query renderer
 * (src/live/filter.ts). Both must agree on where a YYYY-MM-DD day starts
 * and ends, or verify/apply would evaluate different windows than the
 * installed delivery-time rules.
 *
 * Days are interpreted in UTC, not the compiling machine's local zone:
 * compile output must be deterministic across machines (a local-zone
 * read would make mailrules.json differ by who compiled it and churn
 * every date rule's lockfile fingerprint). UTC has no DST transitions,
 * so the `equals:` day window [d, d+1) is always exactly 24h.
 */

/** UTC midnight of a YYYY-MM-DD value, as ISO-8601. Throws on invalid input. */
export function utcMidnightIso(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date value: ${date} (expected YYYY-MM-DD).`);
  }
  return d.toISOString();
}

/** UTC midnight of the calendar day after a YYYY-MM-DD value. */
export function nextUtcMidnightIso(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date value: ${date} (expected YYYY-MM-DD).`);
  }
  return new Date(d.getTime() + 24 * 3600 * 1000).toISOString();
}
