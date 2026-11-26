// Demo mode: a store with the same shape as createStore() in store.js, filled with
// made-up venues and events dated around today. Nothing is read from or written to
// Firebase, so visitors can try the Events, Calendar and Venues views without an account.
// Reviews (Interested / Favorite / Hide) work and are kept only until the page reloads.

const DEMO_ERROR = 'This is the demo, so it can’t follow new venues. Sign in to follow your own.';

// Fictional venues; the addresses are placeholders, not real businesses.
const VENUES = [
  { id: 'demo_hall', name: 'Riverside Music Hall', url: 'https://example.com/riverside-music-hall/events' },
  { id: 'demo_brew', name: 'Old Mill Taproom', url: 'https://example.com/old-mill-taproom/calendar' },
  { id: 'demo_park', name: 'Harbor Community Center', url: 'https://example.com/harbor-community-center/events' },
  { id: 'demo_books', name: 'Lantern Books & Café', url: 'https://example.com/lantern-books/whats-on' },
];

// [venue, dayOffset, hour (null = all day), hours long, category, title, price, description, tags]
const EVENTS = [
  ['demo_hall', 0, 20, 3, 'music', 'The Driftwood Saints with Low Tide Choir', '$18 advance', 'Folk-rock double bill. Doors at 7.'],
  ['demo_brew', 0, 19, 2, 'trivia', 'Pub Trivia Night', 'Free', 'Teams of up to six. Prizes for the top three.'],
  ['demo_books', 1, 18.5, 1.5, 'community', 'Author Talk: Tidepools of the Salish Sea', 'Free', 'A local naturalist reads from a new field guide, with Q&A and signing.'],
  ['demo_park', 1, 10, 1, 'wellness', 'Gentle Yoga by the Water', '$5 suggested', 'All levels. Bring a mat.'],
  ['demo_brew', 2, 18, 3, 'food', 'Oyster & Stout Pairing Night', '$35', 'Four local oysters paired with four stouts.'],
  ['demo_hall', 3, 21, 2, 'comedy', 'Late Night Stand-Up Showcase', '$12', 'Six comics, one host. 21+.'],
  ['demo_park', 4, null, 0, 'market', 'Holiday Makers Market', 'Free entry', 'Forty local artists, food trucks and live carols.', ['holiday']],
  ['demo_books', 4, 11, 1, 'family', 'Story Time', 'Free', 'Picture books and a craft for ages 3 to 7.'],
  ['demo_brew', 5, 15, 3, 'music', 'Bluegrass Jam', 'Free', 'Bring an instrument or just listen.'],
  ['demo_park', 6, 18, 2, 'workshop', 'Wreath Making Workshop', '$40, materials included', 'Build a fresh evergreen wreath to take home.', ['holiday', 'arts']],
  ['demo_hall', 7, 19.5, 2.5, 'film', 'Silent Film Night with Live Piano', '$10', 'A 1920s comedy classic with an improvised score.'],
  ['demo_brew', 8, 19, 2, 'trivia', 'Music Bingo', 'Free', 'Name that tune, fill your card.'],
  ['demo_books', 9, 19, 2, 'arts', 'Watercolor & Wine Evening', '$30', 'Paint a winter harbor scene. No experience needed.'],
  ['demo_park', 10, 9, 3, 'outdoors', 'Beach Cleanup & Birding Walk', 'Free', 'Gloves and bags provided. Meet at the north lot.'],
  ['demo_hall', 11, 20, 3, 'dance', 'Swing Dance Night with the Harbor Big Band', '$15', 'Beginner lesson at 7:30.'],
  ['demo_hall', 13, 20, 3, 'music', 'Winter Solstice Concert', '$22', 'Strings, choir and candles.', ['holiday']],
  ['demo_brew', 15, 17, 4, 'food', 'Ugly Sweater Pint Night', 'Free', 'Best sweater wins a growler fill.', ['holiday']],
  ['demo_park', 18, null, 0, 'notice', 'Center closed for the holiday', '', 'The community center is closed all day.'],
  ['demo_books', 21, 18, 2, 'community', 'Book Swap & Hot Cider', 'Free', 'Bring a book, take a book.'],
  ['demo_hall', 26, 21, 4, 'music', 'New Year’s Eve Dance Party', '$45', 'DJ sets, a midnight toast and a balloon drop.', ['dance', 'holiday']],
];

function startOf(dayOffset, hour) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + dayOffset);
  if (hour != null) d.setHours(Math.floor(hour), Math.round((hour % 1) * 60));
  return d;
}

export function createDemoStore(onChange) {
  const now = new Date();
  const state = {
    loading: false,
    demo: true,
    subscriptions: new Map(),
    venues: new Map(),
    events: new Map(),
    reviews: new Map(),
    profile: null,
    areaChanges: [],
    rBoxes: new Map(),
    rRatings: new Map(),
    rAreas: new Map(),
    restaurants: new Map(),
    rLoaded: true,
    error: null,
  };

  const counts = new Map();
  EVENTS.forEach(([venueId, day, hour, hours, category, title, price, description, tags = []], i) => {
    const start = startOf(day, hour);
    const ev = {
      id: `e${i}`,
      venueId,
      key: `${venueId}__e${i}`,
      title,
      category,
      tags: [category, ...tags],
      price,
      description,
      allDay: hour == null,
      start,
      end: hour == null ? null : new Date(start.getTime() + hours * 3600e3),
      url: VENUES.find((v) => v.id === venueId).url,
      // Events in the coming week arrived recently; later ones were seen earlier.
      firstSeenAt: new Date(now.getTime() - (day < 7 ? 1 : 5) * 864e5),
    };
    if (!state.events.has(venueId)) state.events.set(venueId, new Map());
    state.events.get(venueId).set(ev.id, ev);
    counts.set(venueId, (counts.get(venueId) || 0) + 1);
  });

  for (const v of VENUES) {
    state.subscriptions.set(v.id, { id: v.id, url: v.url, label: '' });
    const checked = new Date(now.getTime() - 2 * 3600e3);
    state.venues.set(v.id, { id: v.id, name: v.name, status: 'ok', eventCount: counts.get(v.id) || 0, lastScrapedAt: { toDate: () => checked } });
  }

  // A few events already reviewed, so every status filter has something in it.
  state.reviews.set('demo_hall__e0', 'favorite');
  state.reviews.set('demo_brew__e4', 'interested');
  state.reviews.set('demo_brew__e7', 'hidden');

  const changed = () => onChange?.(state);
  const refuse = async () => {
    throw new Error(DEMO_ERROR);
  };

  return {
    state,
    addVenue: refuse,
    rescanVenue: async () => {},
    async renameVenue(venueId, label) {
      const sub = state.subscriptions.get(venueId);
      if (sub) sub.label = label.trim().slice(0, 100);
      changed();
    },
    async removeVenue(venueId) {
      state.subscriptions.delete(venueId);
      changed();
    },
    async setReview(ev, reviewState) {
      const current = state.reviews.get(ev.key);
      if (!reviewState || current === reviewState) state.reviews.delete(ev.key);
      else state.reviews.set(ev.key, reviewState);
      changed();
    },
    saveProfile: refuse,
    saveRestaurantBoxes: refuse,
    rateRestaurant: async () => {},
    clearHome: async () => {},
    stop() {},
  };
}
