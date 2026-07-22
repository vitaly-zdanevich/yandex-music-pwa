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
import { WikidataClient, YandexMusicClient } from './sdk';

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
	featuredTrack.liked = false;
	featuredTrack.disliked = false;

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
	Object.defineProperty(navigator, 'userAgent', {
		configurable: true,
		value: 'Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0',
	});
	Object.defineProperty(navigator, 'storage', { configurable: true, value: undefined });
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
	vi.spyOn(WikidataClient.prototype, 'findTrack').mockResolvedValue(undefined);
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
		expect(root.querySelector<HTMLAnchorElement>('#track-title-link')?.hasAttribute('href')).toBe(false);
		expect(root.querySelector('#track-artist')?.textContent).toBe('Alpha, Beta');
		expect(root.querySelector('#track-album')?.textContent).toBe('Album Name');
		expect(root.querySelector<HTMLElement>('#source-label')?.hidden).toBe(true);
		expect(root.querySelector('#source-label')?.textContent).toBe('');
		expect(root.querySelector('#player-status')?.textContent).toBe('Lossless · AAC-MP4 · 256 kbps · 7.6 MB');
		expect(root.querySelector<HTMLImageElement>('#artwork')?.src).toBe(featuredTrack.artworkUrl);
		const actions = root.querySelector<HTMLDetailsElement>('#track-searches')!;
		expect(actions.open).toBe(false);
		expect(actions.querySelector('summary')?.textContent).toBe('Actions');
		expect(actions.contains(root.querySelector('#download-button'))).toBe(true);
		expect(actions.contains(root.querySelector('#share-button'))).toBe(true);
		actions.querySelector<HTMLElement>('summary')!.click();
		expect(actions.open).toBe(true);

		const yandex = root.querySelector<HTMLAnchorElement>('#yandex-link')!;
		const youtube = new URL(root.querySelector<HTMLAnchorElement>('#youtube-link')!.href);
		const google = new URL(root.querySelector<HTMLAnchorElement>('#google-link')!.href);
		const musicBrainz = [
			new URL(root.querySelector<HTMLAnchorElement>('#musicbrainz-track-link')!.href),
			new URL(root.querySelector<HTMLAnchorElement>('#musicbrainz-album-link')!.href),
			new URL(root.querySelector<HTMLAnchorElement>('#musicbrainz-artist-link')!.href),
		];
		const wikidata = [
			new URL(root.querySelector<HTMLAnchorElement>('#wikidata-track-link')!.href),
			new URL(root.querySelector<HTMLAnchorElement>('#wikidata-album-link')!.href),
			new URL(root.querySelector<HTMLAnchorElement>('#wikidata-artist-link')!.href),
		];
		expect(yandex.href).toBe('https://music.yandex.ru/album/album%2F7/track/track%2F1');
		expect(new URL(root.querySelector<HTMLAnchorElement>('#genius-link')!.href).searchParams.get('q')).toBe(
			'Alpha Beta Track / One',
		);
		expect(
			new URL(root.querySelector<HTMLAnchorElement>('#lyrics-translate-link')!.href).searchParams.get('query'),
		).toBe('Track / One Alpha Beta');
		expect(new URL(root.querySelector<HTMLAnchorElement>('#lastfm-link')!.href).searchParams.get('q')).toBe(
			'Alpha Beta Track / One',
		);
		expect(new URL(root.querySelector<HTMLAnchorElement>('#wikipedia-link')!.href).searchParams.get('search')).toBe(
			'Alpha Beta',
		);
		expect(youtube.searchParams.get('search_query')).toBe('Track / One Album Name Alpha Beta');
		expect(google.searchParams.get('q')).toBe('Track / One Album Name Alpha Beta');
		expect(musicBrainz.map((url) => url.searchParams.get('query'))).toEqual([
			'Track / One Alpha Beta',
			'Album Name Alpha Beta',
			'Alpha Beta',
		]);
		expect(musicBrainz.map((url) => url.searchParams.get('type'))).toEqual([
			'recording',
			'release_group',
			'artist',
		]);
		expect(musicBrainz.every((url) => url.searchParams.get('method') === 'indexed')).toBe(true);
		expect(wikidata.map((url) => url.searchParams.get('search'))).toEqual([
			'Track / One Alpha Beta',
			'Album Name Alpha Beta',
			'Alpha Beta',
		]);
		expect(
			[...root.querySelectorAll<HTMLAnchorElement>('.track-links a')].map(({ id }) => id),
		).toEqual([
			'yandex-link',
			'genius-link',
			'lyrics-translate-link',
			'lastfm-link',
			'wikipedia-link',
			'youtube-link',
			'google-link',
			'musicbrainz-track-link',
			'musicbrainz-album-link',
			'musicbrainz-artist-link',
			'wikidata-track-link',
			'wikidata-album-link',
			'wikidata-artist-link',
		]);
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

	it('upgrades the title and supported search buttons from exact Wikidata identifiers', async () => {
		const exactTrack = { ...featuredTrack, id: '30233280', title: 'Last Ring' };
		vi.mocked(YandexMusicClient.prototype.startRecommendations).mockResolvedValueOnce({
			sessionId: 'exact-session',
			batchId: 'exact-batch',
			tracks: [{ track: exactTrack, batchId: 'exact-batch' }],
		});
		vi.mocked(WikidataClient.prototype.findTrack).mockResolvedValueOnce({
			itemId: 'Q105978624',
			musicBrainzRecordingId: 'e1ded706-16ec-45c3-87c4-0ae7a26f56d3',
			youtubeVideoId: 'oKqGUk5qCtU',
			geniusId: 'Complex-numbers-the-last-ring-lyrics',
			lyricsTranslateId: 'complex-numbers-последнее-кольцо-lyrics.html',
		});

		const app = new App(root);
		await app.init();
		await settle();

		const title = root.querySelector<HTMLAnchorElement>('#track-title-link')!;
		expect(title.textContent).toBe('Last Ring');
		expect(title.href).toBe('https://www.wikidata.org/wiki/Q105978624');
		expect(title.target).toBe('_blank');
		expect(title.getAttribute('aria-label')).toContain('Wikidata');
		const exactLinks = {
			genius: root.querySelector<HTMLAnchorElement>('#genius-link')!,
			lyricsTranslate: root.querySelector<HTMLAnchorElement>('#lyrics-translate-link')!,
			musicBrainz: root.querySelector<HTMLAnchorElement>('#musicbrainz-track-link')!,
			youtube: root.querySelector<HTMLAnchorElement>('#youtube-link')!,
		};
		expect(exactLinks.genius.href).toBe('https://genius.com/Complex-numbers-the-last-ring-lyrics');
		const lyricsTranslate = new URL(exactLinks.lyricsTranslate.href);
		expect(lyricsTranslate.origin).toBe('https://lyricstranslate.com');
		expect(decodeURIComponent(lyricsTranslate.pathname)).toBe(
			'/complex-numbers-последнее-кольцо-lyrics.html',
		);
		expect(exactLinks.musicBrainz.href).toBe(
			'https://musicbrainz.org/recording/e1ded706-16ec-45c3-87c4-0ae7a26f56d3',
		);
		expect(exactLinks.youtube.href).toBe('https://www.youtube.com/watch?v=oKqGUk5qCtU');
		for (const link of Object.values(exactLinks)) {
			expect(link.classList.contains('is-exact-match')).toBe(true);
			expect(link.getAttribute('aria-label')).toContain('exact link from Wikidata');
		}
		expect(new URL(root.querySelector<HTMLAnchorElement>('#musicbrainz-album-link')!.href).pathname).toBe('/search');
		expect(new URL(root.querySelector<HTMLAnchorElement>('#musicbrainz-artist-link')!.href).pathname).toBe('/search');
	});

	it('shows the complete Wikidata lookup failure for the current online track', async () => {
		const exactTrack = { ...featuredTrack, id: '30233280', title: 'Last Ring' };
		vi.mocked(YandexMusicClient.prototype.startRecommendations).mockResolvedValueOnce({
			sessionId: 'error-session',
			batchId: 'error-batch',
			tracks: [{ track: exactTrack, batchId: 'error-batch' }],
		});
		const cause = new TypeError('Network connection was lost');
		const failure = new Error('Could not reach Wikidata.');
		failure.stack = 'WikidataApiError: Could not reach Wikidata.\n\tat request (wikidata-transport.ts:24:10)';
		Object.assign(failure, { status: 503 });
		Object.defineProperty(failure, 'cause', { value: cause });
		vi.mocked(WikidataClient.prototype.findTrack).mockRejectedValueOnce(failure);

		const app = new App(root);
		await app.init();
		await settle();

		const popup = root.querySelector<HTMLElement>('#error-popup')!;
		const message = root.querySelector<HTMLElement>('#error-popup-message')!;
		expect(popup.hidden).toBe(false);
		expect(message.textContent).toContain(failure.stack);
		expect(message.textContent).toContain('status: 503');
		expect(message.textContent).toContain('TypeError: Network connection was lost');
	});

	it('does not apply a late Wikidata match to the next track', async () => {
		const first = { ...featuredTrack, id: '30233280', title: 'First track' };
		const second = { ...makeTrack(2), id: '60050452', title: 'Second track' };
		vi.mocked(YandexMusicClient.prototype.startRecommendations).mockResolvedValueOnce({
			sessionId: 'stale-session',
			batchId: 'stale-batch',
			tracks: [first, second].map((track) => ({ track, batchId: 'stale-batch' })),
		});
		let finishFirstLookup = (_match: { itemId: string }): void => undefined;
		let firstSignal: AbortSignal | undefined;
		vi.mocked(WikidataClient.prototype.findTrack)
			.mockImplementationOnce(
				(_trackId, signal) =>
					new Promise((resolve) => {
						firstSignal = signal;
						finishFirstLookup = resolve;
					}),
			)
			.mockResolvedValueOnce(undefined);

		const app = new App(root);
		await app.init();
		await settle();
		root.querySelector<HTMLButtonElement>('#next-button')!.click();
		await settle();
		finishFirstLookup({ itemId: 'Q105978624' });
		await settle();

		expect(firstSignal?.aborted).toBe(true);
		expect(root.querySelector('#track-title')?.textContent).toBe('Second track');
		expect(root.querySelector<HTMLAnchorElement>('#track-title-link')?.hasAttribute('href')).toBe(false);
	});

	it('keeps an offline title plain without starting a Wikidata request', async () => {
		const offlineTrack = { ...featuredTrack, id: '30233280', title: 'Offline track' };
		const offlineCached = cached(offlineTrack);
		cachedTracks.set(offlineTrack.id, offlineCached);
		offlineRecords = [toMetadata(offlineCached)];
		Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
		vi.mocked(YandexMusicClient.prototype.startRecommendations).mockResolvedValueOnce({
			sessionId: 'offline-session',
			batchId: 'offline-batch',
			tracks: [{ track: offlineTrack, batchId: 'offline-batch' }],
		});
		const findTrack = vi.mocked(WikidataClient.prototype.findTrack);
		findTrack.mockClear();

		const app = new App(root);
		await app.init();
		await settle();

		expect(root.querySelector('#track-title')?.textContent).toBe('Offline track');
		expect(root.querySelector<HTMLAnchorElement>('#track-title-link')?.hasAttribute('href')).toBe(false);
		expect(findTrack).not.toHaveBeenCalled();
	});

	it('keeps autoplay intent when Next is tapped before the playing event arrives', async () => {
		const app = new App(root);
		await app.init();
		await settle();
		const playMedia = vi.mocked(HTMLMediaElement.prototype.play);
		playMedia.mockClear();
		playMedia.mockImplementationOnce(function (this: HTMLMediaElement) {
			Object.defineProperty(this, 'paused', { configurable: true, value: false });
			return Promise.resolve();
		});

		root.querySelector<HTMLButtonElement>('#play-button')!.click();
		root.querySelector<HTMLButtonElement>('#next-button')!.click();
		await settle();

		expect(root.querySelector('#track-title')?.textContent).toBe('Track 2');
		expect(playMedia).toHaveBeenCalledTimes(2);
		expect(root.querySelector('#play-button')?.getAttribute('aria-label')).toBe('Pause');
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
		expect(view('offline').getAttribute('aria-label')).toBe('Offline');
		expect(view('offline').querySelector('h1')).toBeNull();
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
		expect(view('settings').getAttribute('aria-label')).toBe('Preferences');
		expect(view('settings').querySelector('.eyebrow')).toBeNull();
		expect(view('settings').querySelector('h1, .settings-intro, .privacy-note')).toBeNull();
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

	it('shows the estimated browser storage left in Preferences when the API is available', async () => {
		const megabyte = 1024 ** 2;
		const estimate = vi.fn().mockResolvedValue({ usage: 25 * megabyte, quota: 100 * megabyte });
		Object.defineProperty(navigator, 'storage', { configurable: true, value: { estimate } });
		const app = new App(root);
		await app.init();
		await settle();

		navButton('settings').click();
		await settle();

		expect(estimate).toHaveBeenCalledOnce();
		expect(root.querySelector<HTMLElement>('#storage-capacity')?.hidden).toBe(false);
		expect(root.querySelector('#storage-capacity-value')?.textContent).toBe('75 MB available · 100 MB quota');
	});

	it('omits the storage-capacity line on an iPhone running iOS 15', async () => {
		const estimate = vi.fn().mockResolvedValue({ usage: 1, quota: 2 });
		Object.defineProperty(navigator, 'userAgent', {
			configurable: true,
			value:
				'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7_9 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1',
		});
		Object.defineProperty(navigator, 'storage', { configurable: true, value: { estimate } });
		const app = new App(root);
		await app.init();
		await settle();

		navButton('settings').click();
		await settle();

		expect(estimate).not.toHaveBeenCalled();
		expect(root.querySelector<HTMLElement>('#storage-capacity')?.hidden).toBe(true);
	});

	it('pauses background caching while a persistent reaction is pending, then resumes it', async () => {
		let finishLike = (): void => undefined;
		const pendingLike = new Promise<void>((resolve) => {
			finishLike = resolve;
		});
		vi.mocked(YandexMusicClient.prototype.setLiked).mockReturnValueOnce(pendingLike);
		const app = new App(root);
		await app.init();
		await settle();
		const cancel = vi.mocked(CacheCoordinator.prototype.cancel);
		const replace = vi.mocked(CacheCoordinator.prototype.replace);
		cancel.mockClear();
		replace.mockClear();

		const like = root.querySelector<HTMLButtonElement>('#like-button')!;
		like.click();
		await Promise.resolve();

		expect(cancel).toHaveBeenCalledOnce();
		expect(like.disabled).toBe(true);
		expect(like.getAttribute('aria-pressed')).toBe('true');
		expect(replace).not.toHaveBeenCalled();

		finishLike();
		await settle();

		expect(like.disabled).toBe(false);
		expect(root.querySelector('#toast')?.textContent).toBe('');
		expect(replace).toHaveBeenCalled();
	});

	it('shows complete network errors until the popup is explicitly closed', async () => {
		const cause = new TypeError('Load failed at the network boundary');
		cause.stack = 'TypeError: Load failed at the network boundary\n\tat fetch (network.ts:9:4)';
		const failure = new Error('Could not reach Yandex Music');
		failure.stack = 'MusicApiError: Could not reach Yandex Music\n\tat setLiked (client.ts:12:3)';
		Object.assign(failure, { status: 502 });
		Object.defineProperty(failure, 'cause', { value: cause });
		vi.mocked(YandexMusicClient.prototype.setLiked).mockRejectedValueOnce(failure);
		const app = new App(root);
		await app.init();
		await settle();
		const like = root.querySelector<HTMLButtonElement>('#like-button')!;
		like.focus();

		like.click();
		await settle();

		const popup = root.querySelector<HTMLElement>('#error-popup')!;
		const message = root.querySelector<HTMLElement>('#error-popup-message')!;
		const close = root.querySelector<HTMLButtonElement>('#error-popup-close')!;
		expect(popup.hidden).toBe(false);
		expect(message.textContent).toContain(failure.stack);
		expect(message.textContent).toContain('status: 502');
		expect(message.textContent).toContain('TypeError: Load failed at the network boundary');
		expect(message.textContent).toContain('at fetch (network.ts:9:4)');
		expect(document.activeElement).toBe(close);

		vi.useFakeTimers();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(popup.hidden).toBe(false);
		close.click();
		expect(popup.hidden).toBe(true);
		expect(document.activeElement).toBe(like);
		vi.useRealTimers();
	});

	it('queues uncaught JavaScript errors and unhandled rejections without interpreting their text as markup', async () => {
		const app = new App(root);
		await app.init();
		await settle();
		const javascriptError = new Error('<img src=x onerror=alert(1)> JavaScript failed');
		javascriptError.stack = 'Error: <img src=x onerror=alert(1)> JavaScript failed\n\tat render (app.ts:5:2)';

		window.dispatchEvent(new ErrorEvent('error', { error: javascriptError, message: javascriptError.message }));
		const rejection = new Event('unhandledrejection');
		Object.defineProperty(rejection, 'reason', { value: new Error('Promise failed in full') });
		window.dispatchEvent(rejection);

		const popup = root.querySelector<HTMLElement>('#error-popup')!;
		const message = root.querySelector<HTMLElement>('#error-popup-message')!;
		const close = root.querySelector<HTMLButtonElement>('#error-popup-close')!;
		expect(popup.hidden).toBe(false);
		expect(message.textContent).toContain(javascriptError.stack);
		expect(message.querySelector('img')).toBeNull();
		expect(close.textContent).toBe('Next error');

		message.scrollTop = 120;
		close.click();
		expect(message.textContent).toContain('Promise failed in full');
		expect(message.scrollTop).toBe(0);
		expect(close.textContent).toBe('Close');
		message.focus();
		message.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' }));
		expect(document.activeElement).toBe(close);
		close.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab', shiftKey: true }));
		expect(document.activeElement).toBe(message);
		close.click();
		expect(popup.hidden).toBe(true);
	});

	it('routes global errors only to the latest initialized app', async () => {
		const firstRoot = root;
		const firstApp = new App(firstRoot);
		await firstApp.init();
		await settle();
		const latestRoot = document.createElement('div');
		document.body.append(latestRoot);
		const latestApp = new App(latestRoot);
		await latestApp.init();
		await settle();

		window.dispatchEvent(new ErrorEvent('error', { error: new Error('Latest app only') }));

		expect(firstRoot.querySelector<HTMLElement>('#error-popup')?.hidden).toBe(true);
		expect(latestRoot.querySelector<HTMLElement>('#error-popup')?.hidden).toBe(false);
		expect(latestRoot.querySelector('#error-popup-message')?.textContent).toContain('Latest app only');
	});

	it('frees the background cache slot while a failed proxy stream recovers', async () => {
		const now = vi.spyOn(Date, 'now').mockReturnValue(0);
		const app = new App(root);
		await app.init();
		await settle();
		root.querySelector<HTMLButtonElement>('#play-button')!.click();
		await settle();
		const audio = root.querySelector('audio')!;
		const cancel = vi.mocked(CacheCoordinator.prototype.cancel);
		const replace = vi.mocked(CacheCoordinator.prototype.replace);
		cancel.mockClear();
		replace.mockClear();

		audio.dispatchEvent(new Event('error'));
		await settle();
		audio.dispatchEvent(new Event('error'));

		expect(cancel).toHaveBeenCalledOnce();
		expect(replace).not.toHaveBeenCalled();

		audio.dispatchEvent(new Event('playing'));
		audio.currentTime = 1;
		audio.dispatchEvent(new Event('timeupdate'));
		now.mockReturnValue(3_000);
		audio.currentTime = 4;
		audio.dispatchEvent(new Event('timeupdate'));
		await settle();
		expect(replace).toHaveBeenCalled();
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

	it('keeps automatic removal disabled only when the retention preference is checked', async () => {
		const app = new App(root);
		await app.init();
		await settle();

		const preference = root.querySelector<HTMLInputElement>('#keep-offline-tracks')!;
		const prune = vi.mocked(IndexedDbOfflineStore.prototype.prune);
		expect(preference.checked).toBe(false);
		expect(preference.labels?.[0]?.textContent).toContain('Do not remove offline tracks');

		prune.mockClear();
		preference.checked = true;
		preference.dispatchEvent(new Event('change'));
		await settle();

		expect(preference.checked).toBe(true);
		expect(window.localStorage.getItem('yandex-music-pwa:keep-offline-tracks:v1')).toBe('true');
		expect(root.querySelector('#offline-retention-help')?.textContent).toContain('only adds tracks');
		expect(prune).not.toHaveBeenCalled();

		preference.checked = false;
		preference.dispatchEvent(new Event('change'));
		await settle();

		expect(window.localStorage.getItem('yandex-music-pwa:keep-offline-tracks:v1')).toBe('false');
		expect(prune.mock.calls.at(-1)?.[0]).toEqual(
			new Set([
				'track-2',
				'track-3',
				'track-4',
				'track-5',
				'track-6',
				'track-7',
				'track-8',
				'track-9',
				'track-10',
				'track-11',
			]),
		);
		expect(prune.mock.calls.at(-1)?.[1]).toBeInstanceOf(AbortSignal);
	});

	it('aborts an in-flight automatic prune when retention is enabled', async () => {
		const app = new App(root);
		await app.init();
		await settle();

		const prune = vi.mocked(IndexedDbOfflineStore.prototype.prune);
		prune.mockClear();
		let markPruneStarted = (): void => undefined;
		const pruneStarted = new Promise<void>((resolve) => {
			markPruneStarted = resolve;
		});
		let observedSignal: AbortSignal | undefined;
		prune.mockImplementationOnce(async (_ids, signal) => {
			if (!signal) throw new Error('A prune signal is required.');
			observedSignal = signal;
			markPruneStarted();
			await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
		});

		const count = root.querySelector<HTMLInputElement>('#offline-track-count')!;
		count.value = '8';
		count.dispatchEvent(new Event('change'));
		await pruneStarted;

		const preference = root.querySelector<HTMLInputElement>('#keep-offline-tracks')!;
		preference.checked = true;
		preference.dispatchEvent(new Event('change'));
		await settle();

		expect(observedSignal?.aborted).toBe(true);
		expect(prune).toHaveBeenCalledTimes(1);
	});

	it('restores add-only retention and still honors an explicit track removal', async () => {
		window.localStorage.setItem('yandex-music-pwa:keep-offline-tracks:v1', 'true');
		const offlineTrack = makeTrack(88);
		const offlineCached = cached(offlineTrack);
		cachedTracks.set(offlineTrack.id, offlineCached);
		offlineRecords = [toMetadata(offlineCached)];
		const remove = vi.mocked(IndexedDbOfflineStore.prototype.remove);

		const app = new App(root);
		await app.init();
		await settle();

		expect(root.querySelector<HTMLInputElement>('#keep-offline-tracks')?.checked).toBe(true);
		expect(IndexedDbOfflineStore.prototype.prune).not.toHaveBeenCalled();
		navButton('offline').click();
		await settle();
		root.querySelector<HTMLButtonElement>('[aria-label="Remove Track 88 from offline"]')!.click();
		await settle();

		expect(remove).toHaveBeenCalledWith(offlineTrack.id);
		expect(root.querySelector('#offline-list')?.textContent).not.toContain(offlineTrack.title);
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
		expect(root.querySelector('#error-popup-message')?.textContent).toContain('Queue unavailable');
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
		expect(root.querySelector('#error-popup-message')?.textContent).toContain('Share unavailable');
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
