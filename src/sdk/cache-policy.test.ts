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
});
