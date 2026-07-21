import { describe, expect, it } from 'vitest';
import type { MusicRequest, MusicTransport } from './types';
import { mapTrack, YandexMusicClient } from './yandex-client';

class FakeTransport implements MusicTransport {
	requests: MusicRequest[] = [];

	constructor(private readonly responses: unknown[]) {}

	async request<T>(request: MusicRequest): Promise<T> {
		this.requests.push(request);
		return this.responses.shift() as T;
	}
}

describe('YandexMusicClient', () => {
	it('maps account and starts the current recommendation session', async () => {
		const transport = new FakeTransport([
			{ account: { uid: 42, displayName: 'Listener' } },
			{
				radioSessionId: 'session',
				batchId: 'batch',
				sequence: [
					{
						type: 'track',
						liked: true,
						track: {
							id: 7,
							title: 'Song',
							durationMs: 123_000,
							artists: [{ id: 1, name: 'Artist' }],
							albums: [{ id: 2, title: 'Album' }],
							coverUri: 'avatars.yandex.net/get/%%',
						},
					},
					{ type: 'ad' },
				],
			},
		]);
		const client = new YandexMusicClient(transport);

		await expect(client.getAccount()).resolves.toEqual({ uid: '42', displayName: 'Listener' });
		const batch = await client.startRecommendations();
		expect(batch.tracks[0]?.track).toMatchObject({
			id: '7',
			title: 'Song',
			liked: true,
			album: { id: '2', title: 'Album' },
			artworkUrl: 'https://avatars.yandex.net/get/400x400',
		});
		expect(transport.requests[1]).toMatchObject({
			path: '/rotor/session/new',
			method: 'POST',
			body: { kind: 'json' },
		});
	});

	it('uses form bodies for persistent likes and dislikes', async () => {
		const transport = new FakeTransport([{}, {}]);
		const client = new YandexMusicClient(transport);
		await client.setLiked('10', '20', true);
		await client.setDisliked('10', '20', false);
		expect(transport.requests).toEqual([
			{
				path: '/users/10/likes/tracks/add-multiple',
				method: 'POST',
				body: { kind: 'form', value: { 'track-ids': '20' } },
				retry: 'transient',
			},
			{
				path: '/users/10/dislikes/tracks/remove',
				method: 'POST',
				body: { kind: 'form', value: { 'track-ids': '20' } },
				retry: 'transient',
			},
		]);
	});

	it('hydrates liked track references in batches', async () => {
		const transport = new FakeTransport([
			{ library: { tracks: [{ id: '1', albumId: '11' }, { id: '2', albumId: '22' }] } },
			[
				{ id: '1', title: 'One', artists: [], albums: [{ id: '11', title: 'A' }] },
				null,
				{ id: '2', title: 'Two', artists: [], albums: [{ id: '22', title: 'B' }] },
			],
		]);
		const tracks = await new YandexMusicClient(transport).getLikedTracks('9');
		expect(tracks.map((track) => [track.id, track.liked])).toEqual([
			['1', true],
			['2', true],
		]);
		expect(transport.requests[1]?.body).toEqual({ kind: 'form', value: { 'track-ids': '1:11,2:22' } });
	});

	it('yields liked tracks a page at a time', async () => {
		const transport = new FakeTransport([
			{ library: { tracks: [{ id: '1' }, { id: '2' }] } },
			[{ id: '1', title: 'One' }],
			[{ id: '2', title: 'Two' }],
		]);
		const pages = new YandexMusicClient(transport).getLikedTrackPages('9', 1);

		await expect(pages.next()).resolves.toMatchObject({
			value: { tracks: [{ id: '1' }], loaded: 1, total: 2, hasMore: true },
		});
		expect(transport.requests).toHaveLength(2);

		await expect(pages.next()).resolves.toMatchObject({
			value: { tracks: [{ id: '2' }], loaded: 2, total: 2, hasMore: false },
		});
		expect(transport.requests).toHaveLength(3);
	});
});

describe('mapTrack', () => {
	it('supplies safe metadata fallbacks', () => {
		expect(mapTrack({ id: '1' })).toEqual({
			id: '1',
			title: 'Untitled track',
			artists: [],
			album: undefined,
			durationMs: 0,
			artworkUrl: undefined,
			liked: false,
			disliked: false,
		});
	});
});
