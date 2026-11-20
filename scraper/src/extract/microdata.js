import * as cheerio from 'cheerio';

export function extractMicrodata(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('[itemscope][itemtype*="schema.org/"][itemtype$="Event"]').each((_, el) => {
    const $el = $(el);
    const prop = (name) => {
      const p = $el.find(`[itemprop="${name}"]`).first();
      if (!p.length) return '';
      return p.attr('content') || p.attr('datetime') || p.attr('href') || p.attr('src') || p.text();
    };
    const start = prop('startDate');
    if (!start) return;
    out.push({
      title: prop('name'),
      start: start.trim(),
      end: prop('endDate')?.trim(),
      description: prop('description'),
      url: prop('url'),
      image: prop('image'),
      location: $el.find('[itemprop="location"]').first().text(),
      source: 'microdata',
    });
  });
  return out;
}
