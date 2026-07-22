import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../sdk';
import { CacheCoordinator, type CacheProgress } from './cache-coordinator';
import type { MediaResolver } from './media-resolver';
import type { OfflineStore } from './offline-store';

const track: Track = {
	id: 'track-1',
	title: 'Highest quality',
	artists: [{ name: 'Artist' }],
	durationMs: 180_000,
	artworkUrl: 'https://avatars.yandex.net/cover.jpg',
	liked: false,
	disliked: false,
};

function storeStub(): OfflineStore {
	return {
		get: vi.fn(),
		getMetadata: vi.fn(),
		has: vi.fn().mockResolvedValue(false),
		put: vi.fn().mockResolvedValue(undefined),
		updateTrack: vi.fn(),
		list: vi.fn(),
		ids: vi.fn(),
		prune: vi.fn(),
		remove: vi.fn(),
		clear: vi.fn(),
		usageBytes: vi.fn(),
	} as OfflineStore;
}

afterEach(() => vi.unstubAllGlobals());

describe('CacheCoordinator', () => {
	it('falls back to Lambda for audio and artwork without leaving large responses in memory twice', async () => {
		const store = storeStub();
		const media: MediaResolver = {
			resolve: vi.fn().mockResolvedValue({
				url: 'https://cdn.yandex.net/audio.flac',
				directUrl: 'https://cdn.yandex.net/audio.flac',
				proxyUrl: 'https://lambda.example/api/media/stream?audio',
				codec: 'flac',
				bitrate: 1411,
				size: 14,
				quality: 'lossless',
			}),
			proxyArtwork: vi.fn().mockReturnValue('https://lambda.example/api/media/stream?artwork'),
		};
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 403 }))
			.mockResolvedValueOnce(new Response(new Blob(['lossless-audio']), { status: 200 }))
			.mockRejectedValueOnce(new TypeError('CORS'))
			.mockResolvedValueOnce(new Response(new Blob(['cover']), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		const progress: CacheProgress[] = [];
		new CacheCoordinator(store, media, (value) => progress.push(value)).enqueue([track]);

		await vi.waitFor(() => expect(store.put).toHaveBeenCalledOnce());
		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
			'https://cdn.yandex.net/audio.flac',
			'https://lambda.example/api/media/stream?audio',
			'https://avatars.yandex.net/cover.jpg',
			'https://lambda.example/api/media/stream?artwork',
		]);
		const [, audio, artwork, details] = vi.mocked(store.put).mock.calls[0]!;
		expect(audio.size).toBe(14);
		expect(artwork?.size).toBe(5);
		expect(details).toEqual({ codec: 'flac', bitrate: 1411, quality: 'lossless' });
		expect(progress.at(-1)).toMatchObject({ pending: 0, completed: track });
	});

	it('clears the active-track progress state after a terminal download error', async () => {
		const store = storeStub();
		const failure = new Error('No playable source');
		const media: MediaResolver = {
			resolve: vi.fn().mockRejectedValue(failure),
			proxyArtwork: vi.fn(),
		};
		const progress: CacheProgress[] = [];
		new CacheCoordinator(store, media, (value) => progress.push(value)).enqueue([track]);

		await vi.waitFor(() => expect(progress.some((value) => value.error)).toBe(true));
		const error = progress.at(-1)?.error;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe('Could not cache Highest quality (track-1).');
		expect((error as Error & { cause?: unknown }).cause).toBe(failure);
		expect(progress.at(-1)?.pending).toBe(0);
		expect(progress.at(-1)?.current).toBeUndefined();
	});

	it('retains a completed superseded download when automatic removal is disabled', async () => {
		const store = storeStub();
		let finishPut = (): void => undefined;
		vi.mocked(store.put).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishPut = () =>
						resolve({
							id: track.id,
							track,
							audio: new Blob(['audio']),
							audioBytes: 5,
							artworkBytes: 0,
							cachedAt: 1,
						});
				}),
		);
		const media: MediaResolver = {
			resolve: vi.fn().mockResolvedValue({
				url: 'https://cdn.yandex.net/audio.m4a',
				proxyUrl: 'https://lambda.example/api/media/stream?audio',
				codec: 'aac-mp4',
				bitrate: 256,
				quality: 'high',
			}),
			proxyArtwork: vi.fn(),
		};
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob(['audio']), { status: 200 })));
		const coordinator = new CacheCoordinator(store, media, () => undefined, () => false);
		coordinator.enqueue([{ ...track, artworkUrl: undefined }]);

		await vi.waitFor(() => expect(store.put).toHaveBeenCalledOnce());
		coordinator.replace([]);
		finishPut();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(store.remove).not.toHaveBeenCalled();
	});
});
