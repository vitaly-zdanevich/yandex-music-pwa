import { describe, expect, it } from 'vitest';
import { selectTracksToCache } from './cache-policy';
import type { RecommendedTrack, Track } from './types';

function item(id: string): RecommendedTrack {
	const track: Track = {
		id,
		title: `Track ${id}`,
		artists: [],
		durationMs: 1,
		liked: false,
		disliked: false,
	};
	return { track, batchId: 'batch' };
}

describe('selectTracksToCache', () => {
	it('selects distinct uncached tracks within the requested horizon', () => {
		const selected = selectTracksToCache(
			[item('1'), item('2'), item('2'), item('3'), item('4')],
			new Set(['1']),
			2,
		);
		expect(selected.map((track) => track.id)).toEqual(['2', '3']);
	});

	it('does not mutate its inputs', () => {
		const upcoming = [item('1'), item('2')];
		const cached = new Set<string>();
		selectTracksToCache(upcoming, cached, 10);
		expect(upcoming).toHaveLength(2);
		expect(cached.size).toBe(0);
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		'returns no tracks for a non-positive or non-finite limit (%s)',
		(limit) => {
			expect(selectTracksToCache([item('1'), item('2')], new Set(), limit)).toEqual([]);
		},
	);

	it('floors a positive fractional limit', () => {
		const selected = selectTracksToCache([item('1'), item('2'), item('3')], new Set(), 2.9);
		expect(selected.map((track) => track.id)).toEqual(['1', '2']);
	});
});
