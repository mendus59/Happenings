// Turn a PDF menu into lines of text, keeping two-column layouts in reading order.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const MAX_PAGES = 8;
const isPrice = (s) => /^\$?\s?\d{1,3}(?:[.,]\d{1,2})?(?:\s*\/\s*\$?\d{1,3}(?:[.,]\d{1,2})?)*$/.test(s.trim());

/** Pure-ish: group positioned text items of one page into lines. */
export function pageLines(textItems, pageWidth) {
  const items = textItems
    .filter((t) => t.str && t.str.trim())
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
  // Two columns when many rows have a second segment starting past the middle.
  const mid = pageWidth / 2;
  const multi = segRows.filter((r) => r.segs.some((sg) => sg.x >= mid * 0.9) && r.segs.some((sg) => sg.x < mid * 0.9)).length;
  const twoCol = multi >= Math.max(3, segRows.length * 0.2);
  if (!twoCol) return segRows.map((r) => r.segs.map((sg) => sg.s).join('  ').trim()).filter(Boolean);
  const left = [];
  const right = [];
  for (const r of segRows) {
    for (const sg of r.segs) (sg.x >= mid * 0.9 ? right : left).push(sg.s.trim());
  }
  return [...left, ...right].filter(Boolean);
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
