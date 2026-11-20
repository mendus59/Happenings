export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Only allow http(s) links from scraped data. */
export const safeHref = (u) => {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '#';
  } catch {
    return '#';
  }
};

const fmt = (opts, tz) => new Intl.DateTimeFormat(undefined, tz ? { ...opts, timeZone: tz } : opts);

/** Local calendar day of an event ("YYYY-MM-DD"). All-day events use the venue's zone. */
export function dayKey(ev) {
  return dayKeyOf(ev.start, ev.allDay ? ev.tz : undefined);
}

export function dayKeyOf(date, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function todayKey() {
  return dayKeyOf(new Date());
}

export function formatDayHeading(key) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = todayKey();
  const tomorrow = dayKeyOf(new Date(Date.now() + 864e5));
  const label = fmt({ weekday: 'long', month: 'long', day: 'numeric' }).format(date);
  if (key === today) return `Today · ${label}`;
  if (key === tomorrow) return `Tomorrow · ${label}`;
  return label;
}

export function formatTimeRange(ev) {
  if (ev.allDay) return 'All day';
  const t = fmt({ hour: 'numeric', minute: '2-digit' });
  return ev.end && ev.end - ev.start < 864e5 ? `${t.format(ev.start)} – ${t.format(ev.end)}` : t.format(ev.start);
}

export function formatWhen(ev) {
  const day = fmt({ weekday: 'short', month: 'short', day: 'numeric', year: ev.start.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined }, ev.allDay ? ev.tz : undefined);
  return `${day.format(ev.start)} · ${formatTimeRange(ev)}`;
}

export function timeAgo(date) {
  if (!date) return 'never';
  const s = (Date.now() - date.getTime()) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Event end (or start) as an instant, for deciding whether it's over. */
export function endsAt(ev) {
  if (ev.allDay) return new Date(ev.start.getTime() + 864e5);
  return ev.end || new Date(ev.start.getTime() + 2 * 3600e3);
}

function icsDate(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => '\\' + c);
}

/** Download a single event as an .ics file so it can be added to any calendar app. */
export function downloadIcs(ev) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Happenings//EN', 'BEGIN:VEVENT', `UID:${ev.key}@happenings`, `DTSTAMP:${icsDate(new Date())}`];
  if (ev.allDay) {
    const k = dayKey(ev).replace(/-/g, '');
    lines.push(`DTSTART;VALUE=DATE:${k}`);
  } else {
    lines.push(`DTSTART:${icsDate(ev.start)}`, `DTEND:${icsDate(endsAt(ev))}`);
  }
  lines.push(`SUMMARY:${icsEscape(ev.title)}`, `LOCATION:${icsEscape(ev.location || ev.venueLabel)}`, `DESCRIPTION:${icsEscape((ev.description || '') + '\n\n' + ev.url)}`, `URL:${ev.url}`, 'END:VEVENT', 'END:VCALENDAR');
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${ev.title.replace(/[^\w]+/g, '-').slice(0, 50)}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem('happenings.' + key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function savePref(key, value) {
  try {
    localStorage.setItem('happenings.' + key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
