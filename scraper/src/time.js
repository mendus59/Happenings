// Small time-zone helpers so we don't need a date library.

/** Offset (ms) of `tz` from UTC at the given instant. */
function tzOffsetMs(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Interpret a wall-clock time in `tz` and return the real instant. */
export function zonedTimeToDate(y, mo, d, h = 0, mi = 0, s = 0, tz = 'UTC') {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let offset = tzOffsetMs(new Date(guess), tz);
  let result = guess - offset;
  // Re-check once in case we crossed a DST boundary.
  const offset2 = tzOffsetMs(new Date(result), tz);
  if (offset2 !== offset) result = guess - offset2;
  return new Date(result);
}

/**
 * Parse an ISO-ish date string. Strings with an explicit offset/Z are exact;
 * strings without one are read as wall-clock time in `tz`.
 * Returns { date, dateOnly } or null.
 */
export function parseDateString(str, tz) {
  if (str == null) return null;
  if (typeof str === 'number') return { date: new Date(str), dateOnly: false };
  if (str instanceof Date) return isNaN(str) ? null : { date: str, dateOnly: false };
  const s = String(str).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { date: zonedTimeToDate(+m[1], +m[2], +m[3], 0, 0, 0, tz), dateOnly: true, ymd: s };
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (m) {
    const [, y, mo, d, h, mi, sec = '0', off] = m;
    if (off) {
      const norm = off.toUpperCase() === 'Z' ? 'Z' : off.length === 5 ? off.slice(0, 3) + ':' + off.slice(3) : off;
      const iso = `${y}-${mo}-${d}T${h.padStart(2, '0')}:${mi}:${sec.padStart(2, '0')}${norm}`;
      const date = new Date(iso);
      return isNaN(date) ? null : { date, dateOnly: false };
    }
    return { date: zonedTimeToDate(+y, +mo, +d, +h, +mi, +sec, tz), dateOnly: false };
  }
  const date = new Date(s);
  return isNaN(date) ? null : { date, dateOnly: false };
}

/** YYYY-MM-DD of an instant in a time zone. */
export function ymdInZone(date, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Hours and minutes of an instant in a time zone. */
export function hmInZone(date, tz) {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(date)
    .split(':')
    .map(Number);
  return { h, m };
}
