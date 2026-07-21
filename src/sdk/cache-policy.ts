import type { RecommendedTrack, Track } from './types';

export function selectTracksToCache(
  upcoming: readonly RecommendedTrack[],
  cachedIds: ReadonlySet<string>,
  limit = 10,
): Track[] {
  const selected: Track[] = [];
  const seen = new Set(cachedIds);
  for (const item of upcoming) {
    if (seen.has(item.track.id)) continue;
    seen.add(item.track.id);
    selected.push(item.track);
    if (selected.length === limit) break;
  }
  return selected;
}
