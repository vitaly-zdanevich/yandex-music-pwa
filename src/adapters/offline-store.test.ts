import { describe, expect, it, vi } from 'vitest';
import type { Track } from '../sdk';
import { IndexedDbOfflineStore } from './offline-store';

function track(id: string): Track {
	return { id, title: id, artists: [], durationMs: 10, liked: false, disliked: false };
}

describe('IndexedDbOfflineStore', () => {
	it('stores audio, artwork, metadata, and exact byte usage', async () => {
		const store = new IndexedDbOfflineStore(`test-${crypto.randomUUID()}`);
		await store.put(track('a'), new Blob(['audio']), new Blob(['art']), {
			codec: 'flac',
			bitrate: 1411,
			quality: 'lossless',
		});
		await store.put(track('b'), new Blob(['1234567890']));

		expect(await store.ids()).toEqual(new Set(['a', 'b']));
		expect(await store.usageBytes()).toBe(18);
		expect((await store.get('a'))?.track.title).toBe('a');
		expect((await store.getMetadata('a'))?.media).toEqual({ codec: 'flac', bitrate: 1411, quality: 'lossless' });
		expect(await store.getMetadata('a')).not.toHaveProperty('audio');
		expect(await store.list()).toEqual(
			expect.arrayContaining([expect.not.objectContaining({ audio: expect.anything() })]),
		);

		await store.prune(new Set(['b']));
		expect(await store.ids()).toEqual(new Set(['b']));

		await store.remove('a');
		expect(await store.has('a')).toBe(false);
		expect(await store.usageBytes()).toBe(10);
		await store.clear();
		expect(await store.list()).toEqual([]);
	});

	it('updates reactions without rewriting media blobs', async () => {
		const store = new IndexedDbOfflineStore(`test-${crypto.randomUUID()}`);
		const original = track('a');
		await store.put(original, new Blob(['audio']));
		await store.updateTrack({ ...original, liked: true });
		const cached = await store.get('a');
		expect(cached?.track.liked).toBe(true);
		expect(cached?.audio.size).toBe(5);
	});

	it('lists downloads in ascending cache order', async () => {
		const store = new IndexedDbOfflineStore(`test-${crypto.randomUUID()}`);
		const now = vi.spyOn(Date, 'now');
		now.mockReturnValue(300);
		await store.put(track('third'), new Blob(['3']));
		now.mockReturnValue(100);
		await store.put(track('first'), new Blob(['1']));
		now.mockReturnValue(200);
		await store.put(track('second'), new Blob(['2']));

		expect((await store.list()).map((entry) => entry.id)).toEqual(['first', 'second', 'third']);
		now.mockRestore();
	});
});
