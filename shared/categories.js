// Display info for event categories. Ids must match scraper/src/categorize.js.
export const CATEGORY_INFO = {
  music: { label: 'Live Music', icon: '🎵', hue: 265 },
  comedy: { label: 'Comedy', icon: '😂', hue: 35 },
  trivia: { label: 'Trivia & Games', icon: '🧠', hue: 200 },
  dance: { label: 'Dance', icon: '💃', hue: 320 },
  workshop: { label: 'Workshop & Class', icon: '🛠️', hue: 170 },
  market: { label: 'Market & Fair', icon: '🛍️', hue: 15 },
  arts: { label: 'Arts & Crafts', icon: '🎨', hue: 290 },
  food: { label: 'Food & Drink', icon: '🍎', hue: 0 },
  outdoors: { label: 'Outdoors & Nature', icon: '🌲', hue: 130 },
  film: { label: 'Film & Theater', icon: '🎭', hue: 240 },
  wellness: { label: 'Fitness & Wellness', icon: '🧘', hue: 150 },
  family: { label: 'Kids & Family', icon: '🧸', hue: 50 },
  holiday: { label: 'Holiday', icon: '🎄', hue: 100 },
  community: { label: 'Community', icon: '🤝', hue: 185 },
  notice: { label: 'Closure / Notice', icon: '📢', hue: 0, muted: true },
  other: { label: 'Other', icon: '📅', hue: 220, muted: true },
};

export const categoryInfo = (id) => CATEGORY_INFO[id] || CATEGORY_INFO.other;
