import { describe, expect, it } from 'vitest';
import { RecommendationSession } from './recommendation-session';
import type { RecommendationBatch, RecommendationClient, RecommendedTrack } from './types';

function item(id: string, batchId: string): RecommendedTrack {
	return {
		batchId,
		track: {
			id,
			title: id,
			artists: [],
			album: { id: `album-${id}`, title: `Album ${id}` },
			durationMs: 0,
			liked: false,
			disliked: false,
		},
	};
}

describe('RecommendationSession', () => {
	it('deduplicates batches and moves backward and forward', async () => {
		const batches: RecommendationBatch[] = [
			{ sessionId: 'session', batchId: 'b2', tracks: [item('2', 'b2'), item('3', 'b2')] },
			{ sessionId: 'session', batchId: 'b3', tracks: [item('4', 'b3')] },
		];
		const historyQueues: string[][] = [];
		const client: RecommendationClient = {
			startRecommendations: async () => ({
				sessionId: 'session',
				batchId: 'b1',
				tracks: [item('1', 'b1'), item('2', 'b1')],
			}),
			getMoreRecommendations: async (_sessionId, queue) => {
				historyQueues.push([...queue]);
				return batches.shift() ?? { sessionId: 'session', batchId: 'empty', tracks: [] };
			},
		};
		const session = new RecommendationSession(client);

		expect((await session.start())?.track.id).toBe('1');
		await session.ensureUpcoming(3);
		expect(session.all.map((entry) => entry.track.id)).toEqual(['1', '2', '3', '4']);
		expect(historyQueues[0]).toEqual(['1:album-1']);
		expect(session.next()?.track.id).toBe('2');
		expect(session.previous()?.track.id).toBe('1');
		expect(session.previous()).toBeUndefined();

		session.reset();
		expect(session.current).toBeUndefined();
		expect(session.sessionId).toBe('');
		expect(session.length).toBe(0);
	});
});
