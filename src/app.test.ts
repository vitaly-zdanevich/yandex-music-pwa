// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { CacheCoordinator } from './adapters/cache-coordinator';
import { ProxyMediaResolver, type MediaSource } from './adapters/media-resolver';
import {
	IndexedDbOfflineStore,
	type CachedTrack,
	type CachedTrackMetadata,
} from './adapters/offline-store';
import { SettingsClient } from './adapters/settings-client';
import { loadGithubHistory } from './lib/github-history';
import { App } from './app';
import type { LikedTrackPage, RecommendationBatch, Track } from './sdk';
import { YandexMusicClient } from './sdk';

vi.mock('./lib/github-history', () => ({ loadGithubHistory: vi.fn() }));

const featuredTrack: Track = {
	id: 'track/1',
	title: 'Track / One',
	artists: [{ name: 'Alpha' }, { name: 'Beta' }],
	album: { id: 'album/7', title: 'Album Name' },
	durationMs: 245_000,
	artworkUrl: 'https://art.example/track-1.jpg',
	liked: false,
	disliked: false,
};

const likedTrack: Track = {
	id: 'liked-1',
	title: 'A liked song',
	artists: [{ name: 'Library Artist' }],
	album: { id: 'liked-album', title: 'Library Album' },
	durationMs: 180_000,
	artworkUrl: 'https://art.example/liked.jpg',
	liked: true,
	disliked: false,
};

const makeTrack = (index: number): Track => ({
	id: `track-${index}`,
	title: `Track ${index}`,
	artists: [{ name: `Artist ${index}` }],
	album: { id: `album-${index}`, title: `Album ${index}` },
	durationMs: 180_000,
	artworkUrl: `https://art.example/${index}.jpg`,
	liked: false,
	disliked: false,
});

const recommendationBatch = (): RecommendationBatch => ({
	sessionId: 'session-1',
	batchId: 'batch-1',
	tracks: [featuredTrack, ...Array.from({ length: 11 }, (_, index) => makeTrack(index + 2))].map((track) => ({
		track,
		batchId: 'batch-1',
	})),
});

const mediaSource = (trackId = featuredTrack.id): MediaSource => ({
	url: `https://cdn.example/${encodeURIComponent(trackId)}.m4a`,
	directUrl: `https://cdn.example/${encodeURIComponent(trackId)}.m4a`,
	proxyUrl: `https://proxy.example/media/${encodeURIComponent(trackId)}`,
	codec: 'aac-mp4',
	bitrate: 256,
	size: 8_000_000,
	quality: 'lossless',
});

class MediaMetadataStub {
	title = '';
	artist = '';
	album = '';
	artwork: MediaImage[] = [];

	constructor(init: MediaMetadataInit = {}) {
		Object.assign(this, init);
	}
}

type MediaSessionStub = {
	metadata: MediaMetadata | null;
	playbackState: MediaSessionPlaybackState;
	setActionHandler: ReturnType<typeof vi.fn>;
	setPositionState: ReturnType<typeof vi.fn>;
};

let root: HTMLElement;
let offlineRecords: CachedTrackMetadata[];
let cachedTracks: Map<string, CachedTrack>;
let likedTracks: Track[];
let mediaSession: MediaSessionStub;
let mediaHandlers: Map<MediaSessionAction, MediaSessionActionHandler | null>;
let share: ReturnType<typeof vi.fn>;
let canShare: ReturnType<typeof vi.fn>;
let status: MockInstance<SettingsClient['status']>;
let objectUrlSequence: number;

const toMetadata = (record: CachedTrack): CachedTrackMetadata => ({
	id: record.id,
	track: record.track,
	artwork: record.artwork,
	audioBytes: record.audioBytes,
	artworkBytes: record.artworkBytes,
	media: record.media,
	cachedAt: record.cachedAt,
});

const settle = async (): Promise<void> => {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
	await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
	for (let index = 0; index < 4; index += 1) await Promise.resolve();
};

const view = (name: 'player' | 'liked' | 'offline' | 'settings'): HTMLElement =>
	root.querySelector<HTMLElement>(`[data-view="${name}"]`)!;

const navButton = (name: 'player' | 'liked' | 'offline' | 'settings'): HTMLButtonElement =>
	root.querySelector<HTMLButtonElement>(`.main-nav [data-screen="${name}"]`)!;

const cached = (track: Track, type = 'audio/mp4'): CachedTrack => {
	const audio = new Blob([new Uint8Array(1_572_864)], { type });
	const artwork = new Blob([new Uint8Array(128)], { type: 'image/jpeg' });
	return {
		id: track.id,
		track,
		artwork,
		audio,
		audioBytes: audio.size,
		artworkBytes: artwork.size,
		media: { codec: 'aac-mp4', bitrate: 256, quality: 'lossless' },
		cachedAt: 1,
	};
};

beforeEach(() => {
	root = document.createElement('div');
	document.body.replaceChildren(root);
	window.localStorage.clear();
	offlineRecords = [];
	cachedTracks = new Map();
	likedTracks = [likedTrack];
	objectUrlSequence = 0;

	vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test-${++objectUrlSequence}`);
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
	vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
	vi.spyOn(window, 'confirm').mockReturnValue(true);

	vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
	vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
		Object.defineProperty(this, 'paused', { configurable: true, value: true });
		this.dispatchEvent(new Event('pause'));
	});
	vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
		Object.defineProperty(this, 'paused', { configurable: true, value: false });
		this.dispatchEvent(new Event('playing'));
		return Promise.resolve();
	});

	mediaHandlers = new Map();
	mediaSession = {
		metadata: null,
		playbackState: 'none',
		setActionHandler: vi.fn((action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
			mediaHandlers.set(action, handler);
		}),
		setPositionState: vi.fn(),
	};
	Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: mediaSession });
	Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
	vi.stubGlobal('MediaMetadata', MediaMetadataStub);

	share = vi.fn().mockResolvedValue(undefined);
	canShare = vi.fn().mockReturnValue(false);
	Object.defineProperty(navigator, 'share', { configurable: true, value: share });
	Object.defineProperty(navigator, 'canShare', { configurable: true, value: canShare });
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: { writeText: vi.fn().mockResolvedValue(undefined) },
	});

	status = vi.spyOn(SettingsClient.prototype, 'status').mockResolvedValue(true);
	vi.mocked(loadGithubHistory).mockResolvedValue([
		{
			sha: '1234567890abcdef1234567890abcdef12345678',
			shortSha: '1234567',
			subject: 'Add preferences history',
			date: '2026-07-21',
			version: __APP_VERSION__,
			url: 'https://github.com/vitaly-zdanevich/yandex-music-pwa/commit/1234567890abcdef1234567890abcdef12345678',
		},
	]);
	vi.spyOn(YandexMusicClient.prototype, 'getAccount').mockResolvedValue({ uid: 'user-1', displayName: 'Listener' });
	vi.spyOn(YandexMusicClient.prototype, 'startRecommendations').mockImplementation(async () => recommendationBatch());
	vi.spyOn(YandexMusicClient.prototype, 'getMoreRecommendations').mockResolvedValue({
		sessionId: 'session-1',
		batchId: 'batch-more',
		tracks: [],
	});
	vi.spyOn(YandexMusicClient.prototype, 'getLikedTrackPages').mockImplementation(async function* () {
		const page: LikedTrackPage = {
			tracks: likedTracks,
			loaded: likedTracks.length,
			total: likedTracks.length,
			hasMore: false,
		};
		yield page;
	});
	vi.spyOn(YandexMusicClient.prototype, 'setLiked').mockResolvedValue(undefined);
	vi.spyOn(YandexMusicClient.prototype, 'setDisliked').mockResolvedValue(undefined);
	vi.spyOn(YandexMusicClient.prototype, 'sendFeedback').mockResolvedValue(undefined);

	vi.spyOn(ProxyMediaResolver.prototype, 'resolve').mockImplementation(async (trackId) => mediaSource(trackId));
	vi.spyOn(CacheCoordinator.prototype, 'replace').mockImplementation(() => undefined);
	vi.spyOn(CacheCoordinator.prototype, 'cancel').mockImplementation(() => undefined);

	vi.spyOn(IndexedDbOfflineStore.prototype, 'get').mockImplementation(async (id) => cachedTracks.get(id));
	vi.spyOn(IndexedDbOfflineStore.prototype, 'getMetadata').mockImplementation(async (id) => {
		const cachedTrack = cachedTracks.get(id);
		return cachedTrack ? toMetadata(cachedTrack) : offlineRecords.find((record) => record.id === id);
	});
	vi.spyOn(IndexedDbOfflineStore.prototype, 'has').mockImplementation(async (id) => cachedTracks.has(id));
	vi.spyOn(IndexedDbOfflineStore.prototype, 'put').mockImplementation(async (track, audio, artwork, media) => {
		const record: CachedTrack = {
			id: track.id,
			track,
			audio,
			artwork,
			audioBytes: audio.size,
			artworkBytes: artwork?.size ?? 0,
			media,
			cachedAt: Date.now(),
		};
		cachedTracks.set(track.id, record);
		offlineRecords.push(toMetadata(record));
		return record;
	});
	vi.spyOn(IndexedDbOfflineStore.prototype, 'updateTrack').mockImplementation(async (track) => {
		const existing = cachedTracks.get(track.id);
		if (existing) existing.track = track;
	});
	vi.spyOn(IndexedDbOfflineStore.prototype, 'list').mockImplementation(async () => [...offlineRecords]);
	vi.spyOn(IndexedDbOfflineStore.prototype, 'ids').mockImplementation(async () => new Set(offlineRecords.map(({ id }) => id)));
	vi.spyOn(IndexedDbOfflineStore.prototype, 'prune').mockResolvedValue(undefined);
	vi.spyOn(IndexedDbOfflineStore.prototype, 'remove').mockImplementation(async (id) => {
		cachedTracks.delete(id);
		offlineRecords = offlineRecords.filter((record) => record.id !== id);
	});
	vi.spyOn(IndexedDbOfflineStore.prototype, 'clear').mockImplementation(async () => {
		cachedTracks.clear();
		offlineRecords = [];
	});
	vi.spyOn(IndexedDbOfflineStore.prototype, 'usageBytes').mockImplementation(async () =>
		offlineRecords.reduce((total, record) => total + record.audioBytes + record.artworkBytes, 0),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

describe('App UI integration', () => {
	it('renders the player without a logo and wires metadata, search, sharing, playback, and track controls', async () => {
		const app = new App(root);
		await app.init();
		await settle();

		expect(root.querySelector('.topbar .brand, .topbar img')).toBeNull();
		expect(view('player').hidden).toBe(false);
		expect(root.querySelector('#track-title')?.textContent).toBe('Track / One');
		expect(root.querySelector('#track-artist')?.textContent).toBe('Alpha, Beta');
		expect(root.querySelector('#track-album')?.textContent).toBe('Album Name');
		expect(root.querySelector('#player-status')?.textContent).toBe('Lossless · AAC-MP4 · 256 kbps · 7.6 MB');
		expect(root.querySelector<HTMLImageElement>('#artwork')?.src).toBe(featuredTrack.artworkUrl);

		const yandex = root.querySelector<HTMLAnchorElement>('#yandex-link')!;
		const youtube = new URL(root.querySelector<HTMLAnchorElement>('#youtube-link')!.href);
		const google = new URL(root.querySelector<HTMLAnchorElement>('#google-link')!.href);
		expect(yandex.href).toBe('https://music.yandex.ru/album/album%2F7/track/track%2F1');
		expect(new URL(root.querySelector<HTMLAnchorElement>('#genius-link')!.href).searchParams.get('q')).toBe(
			'Alpha Beta Track / One',
		);
		expect(new URL(root.querySelector<HTMLAnchorElement>('#lastfm-link')!.href).searchParams.get('q')).toBe(
			'Alpha Beta Track / One',
		);
		expect(new URL(root.querySelector<HTMLAnchorElement>('#wikipedia-link')!.href).searchParams.get('search')).toBe(
			'Alpha Beta',
		);
		expect(new URL(root.querySelector<HTMLAnchorElement>('#wikidata-link')!.href).searchParams.get('search')).toBe(
			'Alpha Beta',
		);
		expect(youtube.searchParams.get('search_query')).toBe('Track / One Album Name Alpha Beta');
		expect(google.searchParams.get('q')).toBe('Track / One Album Name Alpha Beta');
		for (const link of root.querySelectorAll<HTMLAnchorElement>('.track-links a')) {
			expect(link.target).toBe('_blank');
			expect(link.rel).toContain('noopener');
		}

		expect(mediaSession.metadata).toMatchObject({
			title: 'Track / One',
			artist: 'Alpha, Beta',
			album: 'Album Name',
			artwork: [{ src: featuredTrack.artworkUrl, sizes: '400x400' }],
		});
		expect((mediaSession.metadata as MediaMetadataStub).artwork[0]?.src).not.toContain('/icons/');
		expect([...mediaHandlers.keys()]).toEqual(expect.arrayContaining(['play', 'pause', 'previoustrack', 'nexttrack', 'seekto']));

		const audio = root.querySelector('audio')!;
		expect(audio.parentElement).toBe(root);
		Object.defineProperty(audio, 'duration', { configurable: true, value: 245 });
		audio.currentTime = 42;
		mediaSession.setPositionState.mockClear();
		audio.dispatchEvent(new Event('timeupdate'));
		expect(root.querySelector('#elapsed')?.textContent).toBe('0:42');
		expect(root.querySelector('#duration')?.textContent).toBe('4:05');
		expect(mediaSession.setPositionState).toHaveBeenLastCalledWith({ duration: 245, playbackRate: 1, position: 42 });

		const progress = root.querySelector<HTMLInputElement>('#progress')!;
		progress.value = '61';
		progress.dispatchEvent(new Event('input', { bubbles: true }));
		expect(audio.currentTime).toBe(61);

		const play = root.querySelector<HTMLButtonElement>('#play-button')!;
		play.click();
		await settle();
		expect(play.getAttribute('aria-label')).toBe('Pause');
		expect(mediaSession.playbackState).toBe('playing');

		root.querySelector<HTMLButtonElement>('#share-button')!.click();
		expect(share).toHaveBeenCalledWith({
			title: 'Track / One — Alpha, Beta',
			text: 'Track / One — Alpha, Beta',
			url: 'https://music.yandex.ru/album/album%2F7/track/track%2F1',
		});

		root.querySelector<HTMLButtonElement>('#next-button')!.click();
		await settle();
		expect(root.querySelector('#track-title')?.textContent).toBe('Track 2');
		expect(play.getAttribute('aria-label')).toBe('Pause');
		root.querySelector<HTMLButtonElement>('#previous-button')!.click();
		await settle();
		expect(root.querySelector('#track-title')?.textContent).toBe('Track / One');

		mediaHandlers.get('pause')?.({ action: 'pause' });
		expect(play.getAttribute('aria-label')).toBe('Play');
		mediaHandlers.get('seekto')?.({ action: 'seekto', seekTime: 75, fastSeek: false });
		expect(audio.currentTime).toBe(75);
	});

	it('navigates through Liked, Offline, Preferences, and the Preferences Back button using real controls', async () => {
		const offlineTrack = makeTrack(88);
		const offlineCached = cached(offlineTrack);
		cachedTracks.set(offlineTrack.id, offlineCached);
		offlineRecords = [toMetadata(offlineCached)];

		const app = new App(root);
		await app.init();
		await settle();

		navButton('liked').click();
		await settle();
		expect(view('liked').hidden).toBe(false);
		expect(navButton('liked').getAttribute('aria-current')).toBe('page');
		expect(root.querySelector('#liked-message')?.textContent).toBe('1 liked track');
		expect(root.querySelector('#liked-list')?.textContent).toContain('A liked song');
		expect(root.querySelector('#liked-list')?.textContent).toContain('Library Artist');
		expect(root.querySelector('#liked-list')?.textContent).toContain('Library Album');

		navButton('offline').click();
		await settle();
		expect(view('offline').hidden).toBe(false);
		expect(root.querySelector('#offline-usage')?.textContent).toBe('1 track · 1.5 MB');
		expect(root.querySelector('#offline-list')?.textContent).toContain('Track 88');
		expect(root.querySelector('#offline-list')?.textContent).toContain('Artist 88');
		expect(root.querySelector<HTMLButtonElement>('#remove-all')?.disabled).toBe(false);
		expect(root.querySelector('#offline-badge')?.textContent).toBe('1');

		root.querySelector<HTMLButtonElement>('[aria-label="Play Track 88 offline"]')!.click();
		await settle();
		expect(view('player').hidden).toBe(false);
		expect(root.querySelector('#source-label')?.textContent).toBe('Offline download');
		expect(root.querySelector('#track-title')?.textContent).toBe('Track 88');
		expect(root.querySelector('#play-button')?.getAttribute('aria-label')).toBe('Pause');

		navButton('settings').click();
		expect(view('settings').hidden).toBe(false);
		expect(root.querySelector('.settings-view .back-button')?.textContent).toContain('Back');
		await settle();
		expect(root.querySelector('#app-version')?.textContent).toBe(`Version ${__APP_VERSION__}`);
		expect(root.querySelector('.commit-list')?.textContent).toContain(
			`1234567 · v${__APP_VERSION__} · 2026-07-21 · Add preferences history`,
		);
		expect(loadGithubHistory).toHaveBeenCalledTimes(1);
		root.querySelector<HTMLButtonElement>('.settings-view .back-button')!.click();
		await settle();
		expect(view('player').hidden).toBe(false);
		expect(navButton('player').getAttribute('aria-current')).toBe('page');
		expect(root.querySelector('#track-title')?.textContent).toBe('Track 88');
		expect(root.querySelector('#source-label')?.textContent).toBe('Offline download');
	});

	it('persists an adjustable offline-track limit and immediately recalculates the cache horizon', async () => {
		const app = new App(root);
		await app.init();
		await settle();

		const input = root.querySelector<HTMLInputElement>('#offline-track-count')!;
		expect(input.value).toBe('10');
		expect(root.querySelector('#offline-preference-help')?.textContent).toContain(
			'The next 10 recommendations',
		);
		const replace = vi.mocked(CacheCoordinator.prototype.replace);
		replace.mockClear();

		input.value = '3';
		input.dispatchEvent(new Event('change'));
		await settle();

		expect(input.value).toBe('3');
		expect(root.querySelector('#offline-empty-message')?.textContent).toContain(
			'The next 3 recommendations are saved',
		);
		expect(replace).toHaveBeenCalled();
		expect(replace.mock.calls[replace.mock.calls.length - 1]?.[0]).toHaveLength(3);
		expect(window.localStorage.length).toBe(1);
		expect(window.localStorage.getItem(window.localStorage.key(0)!)).toBe('3');

		input.value = '0';
		input.dispatchEvent(new Event('change'));
		await settle();
		expect(root.querySelector('#offline-empty-message')?.textContent).toContain(
			'disabled in Preferences',
		);
		expect(replace.mock.calls[replace.mock.calls.length - 1]?.[0]).toHaveLength(0);
	});

	it('coalesces delayed cache refreshes so the latest offline limit wins', async () => {
		const app = new App(root);
		await app.init();
		await settle();

		const replace = vi.mocked(CacheCoordinator.prototype.replace);
		const prune = vi.mocked(IndexedDbOfflineStore.prototype.prune);
		replace.mockClear();
		prune.mockClear();
		let releaseDelayedPrune = (): void => undefined;
		let markDelayedPruneStarted = (): void => undefined;
		const delayedPruneStarted = new Promise<void>((resolve) => {
			markDelayedPruneStarted = resolve;
		});
		const delayedPrune = new Promise<void>((resolve) => {
			releaseDelayedPrune = resolve;
		});
		prune.mockImplementationOnce(async () => {
			markDelayedPruneStarted();
			await delayedPrune;
		});

		const input = root.querySelector<HTMLInputElement>('#offline-track-count')!;
		input.value = '8';
		input.dispatchEvent(new Event('change'));
		await delayedPruneStarted;

		input.value = '2';
		input.dispatchEvent(new Event('change'));
		await settle();
		expect(replace).not.toHaveBeenCalled();

		releaseDelayedPrune();
		await settle();
		await settle();

		expect(replace).toHaveBeenCalledTimes(1);
		expect(replace.mock.calls[0]?.[0].map((track) => track.id)).toEqual(['track-2', 'track-3']);
		const latestHorizon = prune.mock.calls[prune.mock.calls.length - 1]?.[0];
		expect(latestHorizon).toEqual(new Set(['track-2', 'track-3']));
	});

	it('assigns a preloaded cached track synchronously when an offline track ends', async () => {
		const first = makeTrack(91);
		const second = makeTrack(92);
		const firstCached = cached(first);
		const secondCached = cached(second);
		cachedTracks.set(first.id, firstCached);
		cachedTracks.set(second.id, secondCached);
		offlineRecords = [toMetadata(firstCached), toMetadata(secondCached)];

		const app = new App(root);
		await app.init();
		navButton('offline').click();
		await settle();
		root.querySelector<HTMLButtonElement>('[aria-label="Play Track 91 offline"]')!.click();
		await settle();

		const audio = root.querySelector('audio')!;
		audio.dispatchEvent(new Event('ended'));

		expect(root.querySelector('#track-title')?.textContent).toBe('Track 92');
		expect(root.querySelector('#source-label')?.textContent).toBe('Offline download');
		expect(root.querySelector('#play-button')?.getAttribute('aria-label')).toBe('Pause');
	});

	it('keeps the current track usable when extending the recommendation queue fails', async () => {
		vi.mocked(YandexMusicClient.prototype.startRecommendations).mockResolvedValueOnce({
			sessionId: 'short-session',
			batchId: 'short-batch',
			tracks: [{ track: featuredTrack, batchId: 'short-batch' }],
		});
		vi.mocked(YandexMusicClient.prototype.getMoreRecommendations).mockRejectedValue(new Error('Queue unavailable'));

		const app = new App(root);
		await app.init();
		await settle();
		root.querySelector<HTMLButtonElement>('#play-button')!.click();
		await settle();

		mediaHandlers.get('nexttrack')?.({ action: 'nexttrack' });
		await settle();

		expect(root.querySelector('#track-title')?.textContent).toBe('Track / One');
		expect(root.querySelector('#play-button')?.getAttribute('aria-label')).toBe('Pause');
		expect(root.querySelector('#toast')?.textContent).toBe('Queue unavailable');
	});

	it('uses a newly cached next track instead of a prepared remote URL after going offline', async () => {
		const app = new App(root);
		await app.init();
		await settle();
		root.querySelector<HTMLButtonElement>('#play-button')!.click();
		await settle();

		const next = makeTrack(2);
		cachedTracks.set(next.id, cached(next));
		Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
		root.querySelector<HTMLButtonElement>('#next-button')!.click();
		await settle();

		expect(root.querySelector('#track-title')?.textContent).toBe('Track 2');
		expect(root.querySelector('#player-status')?.textContent).toContain('1.5 MB');
		expect(root.querySelector('#play-button')?.getAttribute('aria-label')).toBe('Pause');
	});

	it('shares an already cached current track as a correctly named audio file', async () => {
		const record = cached(featuredTrack);
		cachedTracks.set(featuredTrack.id, record);
		offlineRecords = [toMetadata(record)];
		canShare.mockReturnValue(true);

		const app = new App(root);
		await app.init();
		await settle();
		share.mockClear();

		root.querySelector<HTMLButtonElement>('#download-button')!.click();
		await settle();

		expect(canShare).toHaveBeenCalled();
		expect(share).toHaveBeenCalledTimes(1);
		const shareData = share.mock.calls[0]?.[0] as ShareData;
		expect(shareData.title).toBe('Track / One — Alpha, Beta');
		expect(shareData.files).toHaveLength(1);
		expect(shareData.files?.[0]).toMatchObject({
			name: 'Alpha, Beta - Track - One.m4a',
			type: 'audio/mp4',
			size: 1_572_864,
		});
	});

	it('falls back to copying a Yandex link and handles a synchronous share failure', async () => {
		const app = new App(root);
		await app.init();
		await settle();
		const writeText = vi.mocked(navigator.clipboard.writeText);
		Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });

		root.querySelector<HTMLButtonElement>('#share-button')!.click();
		await settle();

		expect(writeText).toHaveBeenCalledWith('https://music.yandex.ru/album/album%2F7/track/track%2F1');
		expect(root.querySelector('#toast')?.textContent).toBe('Yandex Music link copied');

		Object.defineProperty(navigator, 'share', {
			configurable: true,
			value: vi.fn(() => {
				throw new Error('Share unavailable');
			}),
		});
		root.querySelector<HTMLButtonElement>('#share-button')!.click();
		expect(root.querySelector('#toast')?.textContent).toBe('The Yandex Music link could not be shared.');
	});

	it('downloads the complete direct media file and exposes it as Save file afterwards', async () => {
		let downloaded: { href: string; name: string } | undefined;
		const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
			downloaded = { href: this.href, name: this.download };
		});
		const fetch = vi.fn().mockResolvedValue(
			new Response(new Uint8Array([1, 2, 3, 4]), {
				status: 200,
				headers: { 'content-type': 'audio/mp4' },
			}),
		);
		vi.stubGlobal('fetch', fetch);

		const app = new App(root);
		await app.init();
		await settle();

		const download = root.querySelector<HTMLButtonElement>('#download-button')!;
		download.click();
		await settle();

		expect(fetch).toHaveBeenCalledWith(mediaSource().url, {
			cache: 'no-store',
			signal: expect.any(AbortSignal),
		});
		expect(downloaded).toEqual({ href: expect.stringMatching(/^blob:test-/), name: 'Alpha, Beta - Track - One.m4a' });
		expect(download.textContent).toBe('Save file');

		download.click();
		expect(click).toHaveBeenCalledTimes(2);
	});

	it('uses a second user tap for iOS file sharing after preparing streamed audio', async () => {
		canShare.mockReturnValue(true);
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(new Uint8Array([1, 2, 3, 4]), {
					status: 200,
					headers: { 'content-type': 'application/octet-stream' },
				}),
			),
		);
		const app = new App(root);
		await app.init();
		await settle();
		share.mockClear();

		const download = root.querySelector<HTMLButtonElement>('#download-button')!;
		download.click();
		await settle();

		expect(download.textContent).toBe('Save file');
		expect(share).not.toHaveBeenCalled();

		download.click();
		expect(share).toHaveBeenCalledOnce();
		expect((share.mock.calls[0]?.[0] as ShareData).files?.[0]).toMatchObject({
			name: 'Alpha, Beta - Track - One.m4a',
			type: 'audio/mp4',
		});
	});

	it('opens Preferences with a server-token message when the proxy is not configured', async () => {
		status.mockResolvedValueOnce(false);
		const app = new App(root);
		await app.init();

		expect(view('settings').hidden).toBe(false);
		expect(root.querySelector('#settings-message')?.textContent).toContain('No server-side Yandex Music token');
		expect(root.querySelector('.topbar .brand, .topbar img')).toBeNull();
		root.querySelector<HTMLButtonElement>('.settings-view .back-button')!.click();
		expect(view('player').hidden).toBe(false);
	});
});
