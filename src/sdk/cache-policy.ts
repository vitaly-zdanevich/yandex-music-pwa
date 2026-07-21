import type { RecommendedTrack, Track } from './types';

export function selectTracksToCache(
	upcoming: readonly RecommendedTrack[],
	cachedIds: ReadonlySet<string>,
	limit = 10,
): Track[] {
	const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
	if (normalizedLimit === 0) return [];

	const selected: Track[] = [];
	const seen = new Set(cachedIds);
	for (const item of upcoming) {
		if (seen.has(item.track.id)) continue;
		seen.add(item.track.id);
		selected.push(item.track);
		if (selected.length === normalizedLimit) break;
	}
	return selected;
}
