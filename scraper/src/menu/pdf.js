// Turn a PDF menu into lines of text, keeping two-column layouts in reading order.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const MAX_PAGES = 8;
const isPrice = (s) => /^\$?\s?\d{1,3}(?:[.,]\d{1,2})?(?:\s*\/\s*\$?\d{1,3}(?:[.,]\d{1,2})?)*$/.test(s.trim());

/** Pure-ish: group positioned text items of one page into lines. */
export function pageLines(textItems, pageWidth) {
  const items = textItems
    // Skip rotated text (decorative lettering on a curve, sideways labels).
    .filter((t) => t.str && t.str.trim() && Math.abs(t.transform[1]) < 0.01 && Math.abs(t.transform[2]) < 0.01)
    .map((t) => ({ x: t.transform[4], y: t.transform[5], w: t.width || 0, h: Math.abs(t.transform[3]) || 10, s: t.str }));
  // Rows: items whose baselines are within a fraction of the font size.
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const it of items) {
    const row = rows.find((r) => Math.abs(r.y - it.y) <= Math.max(2, it.h * 0.35));
    if (row) row.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }
  // Segments: split a row at wide gaps, then glue right-aligned prices back to their dish.
  const segRows = rows.map((r) => {
    const sorted = r.items.sort((a, b) => a.x - b.x);
    const segs = [];
    for (const it of sorted) {
      const last = segs.at(-1);
      const gap = last ? it.x - (last.x2) : Infinity;
      if (last && gap < Math.max(12, it.h * 1.5)) {
        last.s += (gap > it.h * 0.15 && !last.s.endsWith(' ') ? ' ' : '') + it.s;
        last.x2 = it.x + it.w;
      } else segs.push({ x: it.x, x2: it.x + it.w, s: it.s });
    }
    const glued = [];
    for (const sg of segs) {
      const prev = glued.at(-1);
      if (prev && isPrice(sg.s) && !isPrice(prev.s)) {
        prev.s += ' ' + sg.s.trim();
        prev.x2 = sg.x2;
      } else glued.push(sg);
    }
    return { y: r.y, segs: glued };
  });
  return columnOrder(segRows, pageWidth);
}

/**
 * Find column gutters: vertical lines (between 15% and 85% of the page) that few text
 * segments cross, with real text starting on each side. Rows in different columns often sit
 * on different baselines, so this looks at the page as a whole rather than row by row.
 * Segments that do cross a gutter (section titles and notes across the page) split the
 * page into bands, and each band is read column by column.
 */
export function columnOrder(segRows, pageWidth) {
  const flat = segRows.map((r) => r.segs.map((sg) => sg.s).join('  ').trim()).filter(Boolean);
  const segs = segRows.flatMap((r) => r.segs);
  if (segs.length < 8) return flat;
  const step = Math.max(1, pageWidth / 200);
  const crossings = (g) => segs.filter((sg) => sg.x < g - 1 && sg.x2 > g + 1).length;
  const scan = [];
  for (let g = pageWidth * 0.15; g <= pageWidth * 0.85; g += step) scan.push({ g, n: crossings(g) });
  const median = [...scan].sort((a, b) => a.n - b.n)[Math.floor(scan.length / 2)].n;
  const limit = Math.min(Math.max(1, Math.floor(segs.length * 0.15)), Math.floor(median * 0.5));
  // Lowest point of each run of open positions is a candidate gutter.
  const gutters = [];
  let run = [];
  for (const p of [...scan, null]) {
    if (p && p.n <= limit) run.push(p);
    else if (run.length) {
      const low = Math.min(...run.map((q) => q.n));
      const lows = run.filter((q) => q.n === low);
      gutters.push(lows[Math.floor(lows.length / 2)].g);
      run = [];
    }
  }
  // Keep gutters that leave a real column of words (not just a column of prices) on each side.
  const wordy = (sg) => /[a-z]{3}/i.test(sg.s) && !isPrice(sg.s);
  const total = segs.filter(wordy).length;
  const edges = [-Infinity];
  for (const g of gutters) {
    const left = segs.filter((sg) => sg.x >= edges.at(-1) - 1 && sg.x2 <= g + 1 && wordy(sg)).length;
    const right = segs.filter((sg) => sg.x >= g - 1 && wordy(sg)).length;
    if (left >= Math.max(4, total * 0.15) && right >= Math.max(4, total * 0.15)) edges.push(g);
  }
  if (edges.length === 1) return flat;
  edges.push(Infinity);
  const inner = edges.slice(1, -1);
  const spans = (sg) => inner.some((g) => sg.x < g - 1 && sg.x2 > g + 1);
  const out = [];
  let cols = inner.map(() => []).concat([[]]);
  const flush = () => {
    out.push(...cols.flat());
    cols = cols.map(() => []);
  };
  for (const r of segRows) {
    if (r.segs.some(spans)) {
      flush();
      out.push(r.segs.map((sg) => sg.s.trim()).join('  '));
      continue;
    }
    const byCol = cols.map(() => []);
    for (const sg of r.segs) {
      const c = edges.findIndex((e, i) => sg.x >= e - 1 && sg.x < edges[i + 1] - 1);
      byCol[Math.max(0, c)].push(sg.s.trim());
    }
    byCol.forEach((parts, c) => parts.length && cols[c].push(parts.join('  ')));
  }
  flush();
  return out.filter(Boolean);
}

export async function pdfToLines(data) {
  const doc = await getDocument({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: true, disableFontFace: true, verbosity: 0 }).promise;
  const lines = [];
  try {
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
      const page = await doc.getPage(n);
      const { width } = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      lines.push(...pageLines(content.items, width));
    }
  } finally {
    await doc.destroy();
  }
  return lines;
}
