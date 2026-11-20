// Keyword-based event categorization. Order matters: the first matching rule
// becomes the primary category, every matching rule becomes a tag.

export const CATEGORIES = [
  {
    id: 'notice',
    label: 'Closure / Notice',
    re: /\b(closed|closure|cancel+ed|no (live )?music|we'?re closed|sorry,? we)\b/i,
    titleOnly: true,
  },
  { id: 'comedy', label: 'Comedy', re: /\b(comedy|comedian|stand[- ]?up|improv|open mic comedy)\b/i },
  { id: 'trivia', label: 'Trivia & Games', re: /\b(trivia|quiz|bingo|game night|board games?|karaoke|pub quiz)\b/i },
  {
    id: 'music',
    label: 'Live Music',
    re: /\b(live music|music|concert|band|trio|quartet|quintet|duo|jazz|blues|folk|bluegrass|country|honky[- ]?tonk|americana|r&b|soul|funk|disco|rock|punk|indie|hip[- ]?hop|rap|reggae|psychobilly|zydeco|ragtime|rockabilly|tango trio|milonga|western swing|singer|songwriter|acoustic|dj|orchestra|symphony|choir|open mic|jam|fm presents|kptz)\b/i,
  },
  { id: 'dance', label: 'Dance', re: /\b(dance|dancing|swing dance|salsa|contra|tango|ballroom|line dancing)\b/i },
  {
    id: 'workshop',
    label: 'Workshop & Class',
    re: /\b(workshop|class|classes|lesson|course|lecture|seminar|tutorial|foray|instruction|learn|educational|talk)\b/i,
  },
  {
    id: 'market',
    label: 'Market & Fair',
    re: /\b(market|fair|bazaar|festival|fest|sale|vendors?|flea|swap|craft fair|holiday market)\b/i,
  },
  {
    id: 'arts',
    label: 'Arts & Crafts',
    re: /\b(craft|crafts|craft-ernoon|art|arts|painting|paint|pottery|ceramics|glass|wreath|knit|sewing|gallery|exhibit|exhibition|drawing)\b/i,
  },
  {
    id: 'food',
    label: 'Food & Drink',
    re: /\b(tasting|tastings|wine|cider|beer|brew|brewery|dinner|brunch|supper|food|feast|cook|cooking|chef|pairing|happy hour|pop[- ]?up|bbq|barbecue)\b/i,
  },
  {
    id: 'outdoors',
    label: 'Outdoors & Nature',
    re: /\b(hike|hiking|walk|tour|tours|garden|gardening|farm|orchard|nature|mushroom|forag\w*|bird\w*|kayak|paddle|trail|wildlife|marine)\b/i,
  },
  {
    id: 'film',
    label: 'Film & Theater',
    re: /\b(film|movie|cinema|screening|theater|theatre|play|musical|storytelling|story|poetry|reading|book|author)\b/i,
  },
  {
    id: 'wellness',
    label: 'Fitness & Wellness',
    re: /\b(yoga|fitness|run|5k|meditation|wellness|pilates|sound bath|tai chi)\b/i,
  },
  { id: 'family', label: 'Kids & Family', re: /\b(kids?|children|family|families|toddler|storytime|all ages)\b/i },
  { id: 'holiday', label: 'Holiday', re: /\b(holiday|christmas|xmas|halloween|thanksgiving|new year'?s|hanukkah|easter|solstice|valentine)\b/i },
  { id: 'community', label: 'Community', re: /\b(community|meetup|meeting|fundraiser|benefit|volunteer|potluck|gathering|celebration|party)\b/i },
];

export const CATEGORY_LABELS = Object.fromEntries([...CATEGORIES.map((c) => [c.id, c.label]), ['other', 'Other']]);

/**
 * @param {{title: string, description?: string, sourceCategories?: string[]}} ev
 * @returns {{category: string, tags: string[]}}
 */
export function categorize(ev) {
  const title = ev.title || '';
  const extra = [...(ev.sourceCategories || [])].join(' ');
  const desc = (ev.description || '').slice(0, 400);
  const tags = [];
  // Title (and the site's own categories) are strong signals; description is weak.
  for (const c of CATEGORIES) {
    if (c.re.test(title) || c.re.test(extra)) tags.push(c.id);
  }
  if (tags.length === 0) {
    for (const c of CATEGORIES) {
      if (!c.titleOnly && c.re.test(desc)) tags.push(c.id);
    }
  }
  return { category: tags[0] || 'other', tags: tags.length ? tags : ['other'] };
}
