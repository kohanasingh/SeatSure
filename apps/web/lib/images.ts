// Curated Unsplash photos grouped by loose "vibe" keywords found in an
// event's title/description. Deterministic per event (hash of its id), so
// the same event always gets the same photo instead of reshuffling on every
// render. Swap these for real event photography whenever the organizer has
// some — this is a demo-data affordance, not a CMS.

interface PhotoSet {
  keywords: string[];
  photos: string[];
}

const SETS: PhotoSet[] = [
  {
    keywords: ['music', 'festival', 'concert', 'band', 'rock'],
    photos: [
      'https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?auto=format&fit=crop&w=1200&q=80',
    ],
  },
  {
    keywords: ['comedy', 'standup', 'stand-up', 'gala', 'laugh'],
    photos: [
      'https://images.unsplash.com/photo-1585699324551-f6c309eedeca?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1541532713592-79a0317b6b77?auto=format&fit=crop&w=1200&q=80',
    ],
  },
  {
    keywords: ['theatre', 'theater', 'opera', 'orchestra', 'symphony', 'ballet'],
    photos: [
      'https://images.unsplash.com/photo-1503095396549-807759245b35?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1507676184212-d03ab07a01bf?auto=format&fit=crop&w=1200&q=80',
    ],
  },
  {
    keywords: ['sport', 'match', 'game', 'arena', 'stadium'],
    photos: [
      'https://images.unsplash.com/photo-1461896836934-ffe607ba8211?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1517649763962-0c623066013b?auto=format&fit=crop&w=1200&q=80',
    ],
  },
];

const FALLBACK: string[] = [
  'https://images.unsplash.com/photo-1501281668745-f7f57925c3b4?auto=format&fit=crop&w=1200&q=80',
  'https://images.unsplash.com/photo-1429962714451-bb934ecdc4ec?auto=format&fit=crop&w=1200&q=80',
  'https://images.unsplash.com/photo-1472653431158-6364773b2a56?auto=format&fit=crop&w=1200&q=80',
];

const hash = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
};

export function eventPhoto(id: string, title: string, description?: string | null): string {
  const haystack = `${title} ${description ?? ''}`.toLowerCase();
  const matched = SETS.find((set) => set.keywords.some((k) => haystack.includes(k)));
  const pool = matched?.photos ?? FALLBACK;
  return pool[hash(id) % pool.length]!;
}

/** A handful of extra shots for an event's detail-page gallery — same pool,
 * different offsets, so the strip doesn't repeat the hero photo. */
export function eventGallery(id: string, title: string, description?: string | null): string[] {
  const haystack = `${title} ${description ?? ''}`.toLowerCase();
  const matched = SETS.find((set) => set.keywords.some((k) => haystack.includes(k)));
  const pool = matched?.photos ?? FALLBACK;
  const allPools = [...pool, ...FALLBACK.filter((p) => !pool.includes(p))];
  const start = hash(id) % allPools.length;
  return [0, 1, 2].map((i) => allPools[(start + i) % allPools.length]!);
}
