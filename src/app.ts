import { CacheCoordinator, type CacheProgress } from './adapters/cache-coordinator';
import { HttpMusicTransport } from './adapters/http-transport';
import { downloadMediaBlob } from './adapters/media-download';
import { ProxyMediaResolver, type MediaSource } from './adapters/media-resolver';
import { IndexedDbOfflineStore, type CachedTrack, type CachedTrackMetadata } from './adapters/offline-store';
import { SettingsClient } from './adapters/settings-client';
import { estimateStorageCapacity } from './adapters/storage-capacity';
import { isIphoneIos15UserAgent } from './access-policy';
import { artistNames, formatBytes, formatMediaQuality, formatTime } from './lib/format';
import { formatErrorText } from './lib/error-text';
import { loadGithubHistory } from './lib/github-history';
import {
	loadKeepOfflineTracks,
	loadOfflineTrackCount,
	normalizeOfflineTrackCount,
	saveKeepOfflineTracks,
	saveOfflineTrackCount,
} from './lib/offline-preferences';
import { AudioPlayer } from './player/audio-player';
import {
	geniusTrackSearchUrl,
	googleTrackSearchUrl,
	lastFmTrackSearchUrl,
	musicBrainzAlbumSearchUrl,
	musicBrainzArtistSearchUrl,
	musicBrainzTrackSearchUrl,
	RecommendationSession,
	selectTracksToCache,
	type Account,
	type FeedbackType,
	type LikedTrackPage,
	type RecommendedTrack,
	type Track,
	wikidataAlbumSearchUrl,
	wikidataArtistSearchUrl,
	wikidataTrackSearchUrl,
	wikipediaArtistSearchUrl,
	YandexMusicClient,
	yandexMusicTrackUrl,
	youtubeTrackSearchUrl,
} from './sdk';

type Screen = 'player' | 'liked' | 'offline' | 'settings';
type PreparedPlayback =
	| { kind: 'cached'; trackId: string; cached: CachedTrack; objectUrl: string }
	| { kind: 'remote'; trackId: string; source: MediaSource };

const LIBRARY_PAGE_SIZE = 100;
let activeGlobalErrorReporter: ((error: unknown) => void) | undefined;
let globalErrorHandlersInstalled = false;
let reportingGlobalError = false;

export class App {
	private readonly transport = new HttpMusicTransport();
	private readonly client = new YandexMusicClient(this.transport);
	private readonly recommendations = new RecommendationSession(this.client);
	private readonly offlineStore = new IndexedDbOfflineStore();
	private readonly media = new ProxyMediaResolver();
	private readonly settings = new SettingsClient();
	private readonly cache = new CacheCoordinator(
		this.offlineStore,
		this.media,
		(progress) => this.onCacheProgress(progress),
		() => !this.keepOfflineTracks,
	);
	private readonly audio = new AudioPlayer({
		onEnded: () => void this.onEnded(),
		onError: (message) => this.showError(message),
		onMediaReady: () => this.syncMediaSession(),
		onPlayState: (playing) => this.onPlayState(playing),
		onRecoveryState: (recovering) => this.onPlaybackRecoveryState(recovering),
		onTime: (current, duration) => this.renderTime(current, duration),
	});

	private account?: Account;
	private connected = false;
	private connecting = false;
	private screen: Screen = 'player';
	private offlinePlayback?: { records: CachedTrackMetadata[]; index: number };
	private likedTracks: Track[] = [];
	private likedPages?: AsyncGenerator<LikedTrackPage>;
	private likedTotal = 0;
	private likedLoading = false;
	private likedInitialized = false;
	private likedLoadVersion = 0;
	private playerArtworkObjectUrl?: string;
	private listObjectUrls: string[] = [];
	private prepareVersion = 0;
	private feedbackStartedTrackId?: string;
	private readonly manuallyRemovedCacheIds = new Set<string>();
	private navigationVersion = 0;
	private resumeAfterNavigation = false;
	private reactionTrackId?: string;
	private offlineRenderVersion = 0;
	private currentArtworkUrl?: string;
	private currentAudioBlob?: Blob;
	private currentMediaSource?: MediaSource;
	private preparedDownload?: { trackId: string; file: File };
	private downloadVersion = 0;
	private downloadingTrackId?: string;
	private downloadController?: AbortController;
	private settingsReturnScreen: Exclude<Screen, 'settings'> = 'player';
	private preparedNext?: PreparedPlayback;
	private prepareNextVersion = 0;
	private preparingNextTrackId?: string;
	private commitHistoryRequested = false;
	private cacheAheadCount = loadOfflineTrackCount();
	private keepOfflineTracks = loadKeepOfflineTracks();
	private cacheRefreshVersion = 0;
	private cacheRefreshTail: Promise<void> = Promise.resolve();
	private pruneController?: AbortController;
	private cacheSuspendedForPlaybackRecovery = false;
	private storageCapacityVersion = 0;
	private readonly errorQueue: string[] = [];
	private activeErrorText?: string;
	private errorPopupPreviousFocus?: HTMLElement;

	constructor(private readonly root: HTMLElement) {}

	async init(): Promise<void> {
		this.root.innerHTML = template();
		installGlobalErrorHandlers((error) => this.showError(error));
		this.element<HTMLElement>('app-version').textContent = `Version ${__APP_VERSION__}`;
		this.renderOfflinePreference();
		this.audio.mount(this.root);
		this.bindEvents();
		await this.refreshOfflineSummary();
		this.renderPlayer();
		let configured = false;
		let statusError: unknown;
		let statusFailed = false;
		try {
			configured = await this.settings.status();
		} catch (error) {
			statusError = error;
			statusFailed = true;
		}
		if (configured) {
			try {
				await this.connect();
			} catch (error) {
				this.handleConnectionError(error);
			}
		} else {
			if (!navigator.onLine) {
				await this.openOffline();
			} else {
				this.showScreen('settings');
				this.setSettingsMessage(
					statusFailed
						? toMessage(statusError)
						: 'No server-side Yandex Music token was found. For AWS, add it from your deployment terminal, then check again.',
					true,
				);
			}
		}
		if (statusFailed) this.showError(statusError);
	}

	private bindEvents(): void {
		this.root.querySelectorAll<HTMLButtonElement>('[data-screen]').forEach((button) => {
			button.addEventListener('click', () => {
				const screen = button.dataset.screen as Screen;
				if (screen === 'liked') void this.openLiked();
				else if (screen === 'offline') void this.openOffline();
				else if (screen === 'player') this.openPlayer();
				else {
					if (this.screen !== 'settings') this.settingsReturnScreen = this.screen;
					this.showScreen(screen);
				}
			});
		});
		this.element<HTMLButtonElement>('settings-back').addEventListener('click', () => {
			if (this.settingsReturnScreen === 'liked') void this.openLiked();
			else if (this.settingsReturnScreen === 'offline') void this.openOffline();
			else this.showScreen('player');
		});
		this.element<HTMLButtonElement>('play-button').addEventListener('click', () => {
			if (this.audio.trackId !== this.currentTrack?.id) this.audio.primeForUserGesture();
			void this.togglePlayback();
		});
		this.element<HTMLButtonElement>('previous-button').addEventListener('click', () => void this.previous());
		this.element<HTMLButtonElement>('next-button').addEventListener('click', () => void this.next(true));
		this.element<HTMLButtonElement>('like-button').addEventListener('click', () => void this.toggleLike());
		this.element<HTMLButtonElement>('dislike-button').addEventListener('click', () => void this.dislike());
		this.element<HTMLButtonElement>('download-button').addEventListener('click', () => void this.downloadCurrent());
		this.element<HTMLButtonElement>('share-button').addEventListener('click', () => this.shareCurrent());
		this.element<HTMLInputElement>('progress').addEventListener('input', (event) => {
			this.audio.seek(Number((event.currentTarget as HTMLInputElement).value));
		});
		this.element<HTMLButtonElement>('refresh-connection').addEventListener('click', () => void this.refreshConnection());
		this.element<HTMLInputElement>('offline-track-count').addEventListener('change', (event) => {
			this.updateOfflineTrackCount((event.currentTarget as HTMLInputElement).value);
		});
		this.element<HTMLInputElement>('keep-offline-tracks').addEventListener('change', (event) => {
			this.updateKeepOfflineTracks((event.currentTarget as HTMLInputElement).checked);
		});
		this.element<HTMLButtonElement>('remove-all').addEventListener('click', () => void this.removeAllOffline());
		this.element<HTMLButtonElement>('liked-more').addEventListener('click', () => void this.loadNextLikedPage());
		this.element<HTMLButtonElement>('error-popup-close').addEventListener('click', () => this.closeErrorPopup());
		this.element<HTMLElement>('error-popup').addEventListener('keydown', (event) => {
			if (event.key === 'Escape') this.closeErrorPopup();
			else if (event.key === 'Tab') this.trapErrorPopupFocus(event);
		});
		window.addEventListener('online', () => {
			if (this.connected && !this.offlinePlayback) void this.ensureQueueAndCache();
		});
		this.installMediaSessionHandlers();
	}

	private async connect(): Promise<void> {
		if (this.connecting) return;
		this.connecting = true;
		this.setPlayerStatus('Connecting to Yandex Music…');
		try {
			this.navigationVersion += 1;
			this.resumeAfterNavigation = false;
			this.account = await this.client.getAccount();
			const first = await this.recommendations.start();
			if (!first) throw new Error('My Wave did not return any playable tracks.');
			this.connected = true;
			this.offlinePlayback = undefined;
			this.resetLikedTracks();
			this.showScreen('player');
			this.renderPlayer();
			this.setPlayerStatus('Recommended for you');
			this.setSettingsMessage('Connected using the server-side token.');
			void this.safeFeedback('radioStarted', first);
			void this.prepareCurrent();
			void this.ensureQueueAndCache();
		} catch (error) {
			this.connected = false;
			this.account = undefined;
			this.recommendations.reset();
			if (!this.offlinePlayback) {
				this.audio.stop();
				this.renderPlayer();
			}
			throw error;
		} finally {
			this.connecting = false;
		}
	}

	private ensureQueueAndCache(): Promise<void> {
		this.pruneController?.abort();
		const refreshVersion = ++this.cacheRefreshVersion;
		const refresh = this.cacheRefreshTail.then(() => this.refreshQueueAndCache(refreshVersion));
		this.cacheRefreshTail = refresh.catch(() => undefined);
		return refresh;
	}

	private async refreshQueueAndCache(refreshVersion: number): Promise<void> {
		if (!this.canApplyCacheRefresh(refreshVersion)) return;
		const navigationVersion = this.navigationVersion;
		const cacheAheadCount = this.cacheAheadCount;
		const keepOfflineTracks = this.keepOfflineTracks;
		try {
			await this.recommendations.ensureUpcoming(cacheAheadCount);
			if (!this.canApplyCacheRefresh(refreshVersion, navigationVersion, cacheAheadCount, keepOfflineTracks)) return;
			const horizon = this.recommendations.upcoming(cacheAheadCount);
			const horizonIds = new Set(horizon.map((item) => item.track.id));
			if (!keepOfflineTracks) {
				const controller = new AbortController();
				this.pruneController = controller;
				try {
					await this.offlineStore.prune(horizonIds, controller.signal);
				} finally {
					if (this.pruneController === controller) this.pruneController = undefined;
				}
				if (!this.canApplyCacheRefresh(refreshVersion, navigationVersion, cacheAheadCount, keepOfflineTracks)) return;
			}
			const cachedIds = await this.offlineStore.ids();
			if (!this.canApplyCacheRefresh(refreshVersion, navigationVersion, cacheAheadCount, keepOfflineTracks)) return;
			for (const id of this.manuallyRemovedCacheIds) {
				if (!horizonIds.has(id)) this.manuallyRemovedCacheIds.delete(id);
				else cachedIds.add(id);
			}
			this.cache.replace(selectTracksToCache(horizon, cachedIds, cacheAheadCount));
			void this.refreshOfflineSummary();
			this.renderPlayer();
			void this.prepareNextPlayback();
		} catch (error) {
			if (this.canApplyCacheRefresh(refreshVersion, navigationVersion, cacheAheadCount, keepOfflineTracks)) {
				this.showError(error);
			}
		}
	}

	private canApplyCacheRefresh(
		refreshVersion: number,
		navigationVersion = this.navigationVersion,
		cacheAheadCount = this.cacheAheadCount,
		keepOfflineTracks = this.keepOfflineTracks,
	): boolean {
		return (
			refreshVersion === this.cacheRefreshVersion &&
			navigationVersion === this.navigationVersion &&
			cacheAheadCount === this.cacheAheadCount &&
			keepOfflineTracks === this.keepOfflineTracks &&
			this.connected &&
			!this.reactionTrackId &&
			!this.cacheSuspendedForPlaybackRecovery &&
			!this.offlinePlayback &&
			navigator.onLine
		);
	}

	private get currentTrack(): Track | undefined {
		return this.offlinePlayback
			? this.offlinePlayback.records[this.offlinePlayback.index]?.track
			: this.recommendations.current?.track;
	}

	private get currentRecommended(): RecommendedTrack | undefined {
		return this.offlinePlayback ? undefined : this.recommendations.current;
	}

	private get nextTrack(): Track | undefined {
		return this.offlinePlayback
			? this.offlinePlayback.records[this.offlinePlayback.index + 1]?.track
			: this.recommendations.all[this.recommendations.index + 1]?.track;
	}

	private renderPlayer(): void {
		const track = this.currentTrack;
		const hasTrack = Boolean(track);
		this.element<HTMLElement>('player-empty').hidden = hasTrack;
		this.element<HTMLElement>('player-content').hidden = !hasTrack;
		if (!track) {
			this.invalidatePreparedNext();
			this.resetCurrentMedia('');
			this.element<HTMLButtonElement>('previous-button').disabled = true;
			this.element<HTMLButtonElement>('next-button').disabled = true;
			if ('mediaSession' in navigator) {
				try {
					navigator.mediaSession.metadata = null;
					navigator.mediaSession.playbackState = 'none';
				} catch {
					// Safari may expose Media Session before its backing session exists.
				}
			}
			return;
		}

		this.element<HTMLElement>('track-title').textContent = track.title;
		this.element<HTMLElement>('track-artist').textContent = artistNames(track);
		this.element<HTMLElement>('track-album').textContent = track.album?.title || 'Unknown album';
		this.element<HTMLButtonElement>('like-button').classList.toggle('is-active', track.liked);
		this.element<HTMLButtonElement>('like-button').setAttribute('aria-pressed', String(track.liked));
		this.element<HTMLButtonElement>('dislike-button').classList.toggle('is-active', track.disliked);
		this.element<HTMLButtonElement>('dislike-button').setAttribute('aria-pressed', String(track.disliked));
		const reactionPending = this.reactionTrackId === track.id;
		this.element<HTMLButtonElement>('like-button').disabled = reactionPending;
		this.element<HTMLButtonElement>('dislike-button').disabled = reactionPending;
		this.element<HTMLButtonElement>('previous-button').disabled = this.offlinePlayback
			? this.offlinePlayback.index === 0
			: this.recommendations.index === 0;
		this.element<HTMLButtonElement>('next-button').disabled = this.offlinePlayback
			? this.offlinePlayback.index + 1 >= this.offlinePlayback.records.length
			: this.recommendations.index + 1 >= this.recommendations.length;
		const sourceLabel = this.element<HTMLElement>('source-label');
		sourceLabel.textContent = this.offlinePlayback ? 'Offline download' : '';
		sourceLabel.hidden = !this.offlinePlayback;
		this.currentArtworkUrl = track.artworkUrl;
		this.renderTrackLinks(track);
		this.renderDownloadButton(track);
		this.updateMediaMetadata(track);
		void this.renderCurrentArtwork(track);
	}

	private async renderCurrentArtwork(track: Track): Promise<void> {
		const expectedId = track.id;
		let artworkUrl = track.artworkUrl;
		const cached = this.offlinePlayback
			? this.offlinePlayback.records[this.offlinePlayback.index]
			: await this.offlineStore.getMetadata(track.id);
		if (cached?.artwork) artworkUrl = URL.createObjectURL(cached.artwork);
		if (this.currentTrack?.id !== expectedId) {
			if (cached?.artwork && artworkUrl) URL.revokeObjectURL(artworkUrl);
			return;
		}
		if (this.playerArtworkObjectUrl) URL.revokeObjectURL(this.playerArtworkObjectUrl);
		this.playerArtworkObjectUrl = cached?.artwork ? artworkUrl : undefined;
		this.currentArtworkUrl = artworkUrl;
		// Prefer the cached blob for Now Playing as well. This keeps lock-screen
		// artwork available after the phone loses its network connection.
		this.updateMediaMetadata(track, artworkUrl);
		const image = this.element<HTMLImageElement>('artwork');
		const placeholder = this.element<HTMLElement>('artwork-placeholder');
		if (artworkUrl) {
			image.src = artworkUrl;
			image.alt = `${track.title} artwork`;
			image.hidden = false;
			placeholder.hidden = true;
		} else {
			image.removeAttribute('src');
			image.hidden = true;
			placeholder.hidden = false;
		}
	}

	private async prepareCurrent(): Promise<void> {
		const track = this.currentTrack;
		if (!track) return;
		if (this.audio.trackId === track.id) {
			void this.prepareNextPlayback();
			return;
		}
		const version = ++this.prepareVersion;
		this.invalidatePreparedNext();
		this.resetCurrentMedia(track.id);
		this.setPlayerStatus(this.offlinePlayback ? 'Opening download…' : 'Preparing track…');
		try {
			const cached = await this.offlineStore.get(track.id);
			if (version !== this.prepareVersion || this.currentTrack?.id !== track.id) return;
			if (cached) {
				this.loadCachedTrack(track, cached);
			} else {
				if (!navigator.onLine) throw new Error('This track is not downloaded. Open Offline to choose a cached track.');
				const source = await this.media.resolve(track.id);
				if (version !== this.prepareVersion || this.currentTrack?.id !== track.id) return;
				this.loadRemoteTrack(track, source);
			}
			this.renderDownloadButton(track);
			void this.prepareNextPlayback();
		} catch (error) {
			this.setPlayerStatus(toMessage(error));
			this.showError(error);
		}
	}

	private loadCachedTrack(track: Track, cached: CachedTrack, objectUrl = URL.createObjectURL(cached.audio)): void {
		this.currentAudioBlob = cached.audio;
		this.currentMediaSource = undefined;
		this.audio.load(track, objectUrl, true);
		this.setPlayerStatus(
			formatMediaQuality(
				{
					...cached.media,
					codec: cached.media?.codec || codecFromMime(cached.audio.type),
					size: cached.audioBytes,
				},
				track.durationMs,
			),
		);
	}

	private loadRemoteTrack(track: Track, source: MediaSource): void {
		this.currentAudioBlob = undefined;
		this.currentMediaSource = source;
		const fallback = source.proxyUrl && source.proxyUrl !== source.url ? source.proxyUrl : undefined;
		this.audio.load(track, source.url, false, fallback, source.proxyUrl === source.url);
		this.setPlayerStatus(formatMediaQuality(source, track.durationMs));
	}

	private async prepareNextPlayback(): Promise<void> {
		const track = this.nextTrack;
		if (!track) {
			this.invalidatePreparedNext();
			return;
		}
		if (this.preparedNext?.trackId === track.id || this.preparingNextTrackId === track.id) return;
		const version = ++this.prepareNextVersion;
		this.releasePreparedNext();
		this.preparingNextTrackId = track.id;
		try {
			const cached = await this.offlineStore.get(track.id);
			if (version !== this.prepareNextVersion || this.nextTrack?.id !== track.id) return;
			if (cached) {
				const objectUrl = URL.createObjectURL(cached.audio);
				if (version !== this.prepareNextVersion || this.nextTrack?.id !== track.id) {
					URL.revokeObjectURL(objectUrl);
					return;
				}
				this.preparedNext = { kind: 'cached', trackId: track.id, cached, objectUrl };
			} else if (navigator.onLine) {
				const source = await this.media.resolve(track.id);
				if (version === this.prepareNextVersion && this.nextTrack?.id === track.id) {
					this.preparedNext = { kind: 'remote', trackId: track.id, source };
				}
			}
		} catch {
			// Preloading is an optimization; the normal preparation path remains available.
		} finally {
			if (version === this.prepareNextVersion) this.preparingNextTrackId = undefined;
		}
	}

	private activatePreparedCurrent(track: Track): boolean {
		const prepared = this.preparedNext;
		if (!prepared || prepared.trackId !== track.id) return false;
		if (prepared.kind === 'remote' && !navigator.onLine) {
			this.invalidatePreparedNext();
			return false;
		}
		this.preparedNext = undefined;
		this.prepareNextVersion += 1;
		this.preparingNextTrackId = undefined;
		this.resetCurrentMedia(track.id);
		if (prepared.kind === 'cached') this.loadCachedTrack(track, prepared.cached, prepared.objectUrl);
		else this.loadRemoteTrack(track, prepared.source);
		this.renderDownloadButton(track);
		void this.prepareNextPlayback();
		return true;
	}

	private invalidatePreparedNext(): void {
		this.prepareNextVersion += 1;
		this.preparingNextTrackId = undefined;
		this.releasePreparedNext();
	}

	private releasePreparedNext(): void {
		if (this.preparedNext?.kind === 'cached') URL.revokeObjectURL(this.preparedNext.objectUrl);
		this.preparedNext = undefined;
	}

	private async togglePlayback(): Promise<void> {
		let track = this.currentTrack;
		if (!track) {
			await this.connect().catch((error) => this.handleConnectionError(error));
			track = this.currentTrack;
			if (!track) return;
		}
		if (this.audio.trackId !== track.id) await this.prepareCurrent();
		if (this.audio.trackId !== track.id) {
			this.audio.stop();
			this.showError('The track is not ready yet. Check your connection.');
			return;
		}
		if (this.audio.playing) {
			this.resumeAfterNavigation = false;
			this.audio.pause();
		} else {
			await this.resumePlayback();
		}
	}

	private async resumePlayback(): Promise<void> {
		const track = this.currentTrack;
		if (!track) return;
		if (this.audio.trackId !== track.id) await this.prepareCurrent();
		if (this.audio.trackId === track.id) await this.audio.play();
	}

	private async next(autoPlay: boolean, sendSkip = true): Promise<void> {
		const navigation = ++this.navigationVersion;
		if (!sendSkip || (autoPlay && (this.audio.playbackRequested || this.resumeAfterNavigation))) {
			this.resumeAfterNavigation = true;
		}
		if (this.offlinePlayback) {
			if (this.offlinePlayback.index + 1 >= this.offlinePlayback.records.length) {
				if (navigation === this.navigationVersion) this.resumeAfterNavigation = false;
				return;
			}
		} else if (this.recommendations.index + 1 >= this.recommendations.length) {
			try {
				await this.recommendations.ensureUpcoming(Math.max(1, this.cacheAheadCount));
			} catch (error) {
				if (navigation === this.navigationVersion) {
					this.resumeAfterNavigation = false;
					this.showError(error);
				}
				return;
			}
			if (navigation !== this.navigationVersion) return;
			if (this.recommendations.index + 1 >= this.recommendations.length) {
				this.resumeAfterNavigation = false;
				this.showError('No more recommendations are available right now.');
				return;
			}
		}

		const previous = this.currentRecommended;
		if (sendSkip && previous) void this.safeFeedback('skip', previous, this.audio.currentTime);
		// Keep the same connected media element and its current source alive until
		// the replacement is assigned. iOS 15 otherwise loses Now Playing state.
		this.audio.pause();
		this.feedbackStartedTrackId = undefined;

		if (this.offlinePlayback) {
			this.offlinePlayback.index += 1;
		} else {
			this.recommendations.next();
		}
		this.renderPlayer();
		const track = this.currentTrack;
		if (!track || !this.activatePreparedCurrent(track)) await this.prepareCurrent();
		if (navigation !== this.navigationVersion) return;
		if (this.resumeAfterNavigation && this.audio.trackId === this.currentTrack?.id) await this.audio.play();
		if (navigation === this.navigationVersion) this.resumeAfterNavigation = false;
		if (!this.offlinePlayback) void this.ensureQueueAndCache();
	}

	private async previous(): Promise<void> {
		if (this.offlinePlayback ? this.offlinePlayback.index === 0 : this.recommendations.index === 0) return;
		const navigation = ++this.navigationVersion;
		if (this.audio.playbackRequested || this.resumeAfterNavigation) this.resumeAfterNavigation = true;
		const previous = this.currentRecommended;
		if (previous) void this.safeFeedback('skip', previous, this.audio.currentTime);
		this.audio.pause();
		this.feedbackStartedTrackId = undefined;
		if (this.offlinePlayback) {
			if (this.offlinePlayback.index === 0) return;
			this.offlinePlayback.index -= 1;
		} else if (!this.recommendations.previous()) {
			return;
		}
		this.renderPlayer();
		await this.prepareCurrent();
		if (navigation !== this.navigationVersion) return;
		if (this.resumeAfterNavigation && this.audio.trackId === this.currentTrack?.id) await this.audio.play();
		if (navigation === this.navigationVersion) this.resumeAfterNavigation = false;
	}

	private async onEnded(): Promise<void> {
		const finished = this.currentRecommended;
		if (finished) void this.safeFeedback('trackFinished', finished, this.audio.currentTime);
		await this.next(true, false);
	}

	private onPlayState(playing: boolean): void {
		const button = this.element<HTMLButtonElement>('play-button');
		button.classList.toggle('is-playing', playing);
		button.setAttribute('aria-label', playing ? 'Pause' : 'Play');
		button.querySelector<HTMLElement>('[data-play]')!.hidden = playing;
		button.querySelector<HTMLElement>('[data-pause]')!.hidden = !playing;
		if ('mediaSession' in navigator) {
			try {
				navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
			} catch {
				// Media Session state is advisory and must never break playback.
			}
		}
		const current = this.currentRecommended;
		if (playing && current && this.feedbackStartedTrackId !== current.track.id) {
			this.feedbackStartedTrackId = current.track.id;
			void this.safeFeedback('trackStarted', current);
		}
	}

	private onPlaybackRecoveryState(recovering: boolean): void {
		if (recovering) {
			if (this.offlinePlayback || this.cacheSuspendedForPlaybackRecovery) return;
			this.cacheSuspendedForPlaybackRecovery = true;
			this.cacheRefreshVersion += 1;
			this.cache.cancel();
			return;
		}
		if (!this.cacheSuspendedForPlaybackRecovery) return;
		this.cacheSuspendedForPlaybackRecovery = false;
		if (this.connected && !this.offlinePlayback && navigator.onLine) void this.ensureQueueAndCache();
	}

	private renderTime(current: number, duration: number): void {
		const progress = this.element<HTMLInputElement>('progress');
		progress.max = String(duration || 0);
		progress.value = String(Math.min(current, duration || current));
		this.element<HTMLElement>('elapsed').textContent = formatTime(current);
		this.element<HTMLElement>('duration').textContent = formatTime(duration);
		this.updateMediaPosition(current, duration);
	}

	private async toggleLike(): Promise<void> {
		const track = this.currentTrack;
		if (!track || !this.account) return this.requireConnection();
		if (this.reactionTrackId) return;
		const recommended = this.currentRecommended;
		this.reactionTrackId = track.id;
		this.cache.cancel();
		const liked = !track.liked;
		const previous = { liked: track.liked, disliked: track.disliked };
		track.liked = liked;
		if (liked) track.disliked = false;
		this.renderPlayer();
		try {
			await this.client.setLiked(this.account.uid, track.id, liked);
			await this.offlineStore.updateTrack(track);
			if (liked && recommended) void this.safeFeedback('like', recommended);
			this.resetLikedTracks();
			if (!liked) this.showToast('Removed from Liked');
		} catch (error) {
			Object.assign(track, previous);
			this.renderPlayer();
			this.showError(error);
		} finally {
			const ownsReaction = this.reactionTrackId === track.id;
			if (ownsReaction) this.reactionTrackId = undefined;
			if (this.currentTrack?.id === track.id) this.renderPlayer();
			if (ownsReaction && this.connected && !this.offlinePlayback && navigator.onLine) void this.ensureQueueAndCache();
		}
	}

	private async dislike(): Promise<void> {
		const track = this.currentTrack;
		if (!track || !this.account) return this.requireConnection();
		if (this.reactionTrackId) return;
		const recommended = this.currentRecommended;
		this.reactionTrackId = track.id;
		this.cache.cancel();
		const previous = { liked: track.liked, disliked: track.disliked };
		track.disliked = true;
		track.liked = false;
		this.renderPlayer();
		try {
			await this.client.setDisliked(this.account.uid, track.id, true);
			await this.offlineStore.updateTrack(track);
			if (recommended) void this.safeFeedback('dislike', recommended);
			this.resetLikedTracks();
			this.showToast('This track will not be recommended');
			if (this.currentTrack?.id === track.id) await this.next(true);
		} catch (error) {
			Object.assign(track, previous);
			this.renderPlayer();
			this.showError(error);
		} finally {
			const ownsReaction = this.reactionTrackId === track.id;
			if (ownsReaction) this.reactionTrackId = undefined;
			if (this.currentTrack?.id === track.id) this.renderPlayer();
			if (ownsReaction && this.connected && !this.offlinePlayback && navigator.onLine) void this.ensureQueueAndCache();
		}
	}

	private async safeFeedback(type: FeedbackType, item: RecommendedTrack, seconds?: number): Promise<void> {
		if (!this.recommendations.sessionId) return;
		try {
			await this.client.sendFeedback(this.recommendations.sessionId, {
				type,
				batchId: item.batchId,
				trackId: type === 'radioStarted' ? undefined : item.track.id,
				totalPlayedSeconds: seconds === undefined ? undefined : Math.max(0, Math.round(seconds)),
			});
		} catch {
			// Feedback must never interrupt playback.
		}
	}

	private async openLiked(): Promise<void> {
		this.showScreen('liked');
		if (!this.account) {
			this.element<HTMLElement>('liked-message').textContent = 'Connect your Yandex Music account in Preferences.';
			return;
		}
		if (this.likedInitialized || this.likedPages || this.likedLoading) {
			this.renderLikedList();
			return;
		}
		this.element<HTMLElement>('liked-message').textContent = 'Loading liked tracks…';
		this.likedPages = this.client.getLikedTrackPages(this.account.uid, LIBRARY_PAGE_SIZE);
		void this.loadNextLikedPage();
	}

	private async loadNextLikedPage(): Promise<void> {
		const pages = this.likedPages;
		if (!pages || this.likedLoading) return;
		const version = this.likedLoadVersion;
		this.likedLoading = true;
		this.element<HTMLButtonElement>('liked-more').disabled = true;
		try {
			const result = await pages.next();
			if (version !== this.likedLoadVersion || pages !== this.likedPages) return;
			if (result.done) {
				this.likedPages = undefined;
				this.likedInitialized = true;
			} else {
				this.likedTracks.push(...result.value.tracks);
				this.likedTotal = result.value.total;
				if (!result.value.hasMore) {
					this.likedPages = undefined;
					this.likedInitialized = true;
				}
			}
			if (this.screen === 'liked') this.renderLikedList();
		} catch (error) {
			if (version === this.likedLoadVersion) {
				this.likedPages = undefined;
				this.element<HTMLElement>('liked-message').textContent = toMessage(error);
				this.showError(error);
			}
		} finally {
			if (version === this.likedLoadVersion) {
				this.likedLoading = false;
				this.element<HTMLButtonElement>('liked-more').disabled = false;
			}
		}
	}

	private renderLikedList(): void {
		this.releaseListObjectUrls();
		const list = this.element<HTMLElement>('liked-list');
		list.replaceChildren();
		for (const track of this.likedTracks) list.append(this.createTrackRow(track));
		this.element<HTMLElement>('liked-message').textContent = this.likedTracks.length
			? this.likedPages
				? `${this.likedTracks.length} of ${this.likedTotal} liked tracks`
				: `${this.likedTracks.length} liked ${this.likedTracks.length === 1 ? 'track' : 'tracks'}`
			: 'No liked tracks yet.';
		this.element<HTMLButtonElement>('liked-more').hidden = !this.likedPages;
	}

	private resetLikedTracks(): void {
		this.likedLoadVersion += 1;
		this.likedPages = undefined;
		this.likedTracks = [];
		this.likedTotal = 0;
		this.likedLoading = false;
		this.likedInitialized = false;
	}

	private async openOffline(): Promise<void> {
		this.showScreen('offline');
		await this.renderOfflineList();
	}

	private openPlayer(): void {
		if (this.offlinePlayback && this.recommendations.current) {
			this.navigationVersion += 1;
			this.resumeAfterNavigation = false;
			this.audio.stop();
			this.offlinePlayback = undefined;
			this.feedbackStartedTrackId = undefined;
			this.renderPlayer();
			void this.prepareCurrent();
			if (this.connected) void this.ensureQueueAndCache();
		}
		this.showScreen('player');
	}

	private async renderOfflineList(): Promise<void> {
		const version = ++this.offlineRenderVersion;
		const records = await this.offlineStore.list();
		if (version !== this.offlineRenderVersion) return;
		const bytes = records.reduce((total, record) => total + record.audioBytes + record.artworkBytes, 0);
		await this.refreshOfflineSummary(records.length, bytes);
		if (version !== this.offlineRenderVersion || this.screen !== 'offline') return;
		this.releaseListObjectUrls();
		this.element<HTMLElement>('offline-usage').textContent = `${records.length} ${records.length === 1 ? 'track' : 'tracks'} · ${formatBytes(bytes)}`;
		this.element<HTMLButtonElement>('remove-all').disabled = records.length === 0;
		const list = this.element<HTMLElement>('offline-list');
		list.replaceChildren();
		this.element<HTMLElement>('offline-empty').hidden = records.length !== 0;
		for (const [index, record] of records.entries()) {
			const row = this.createTrackRow(record.track, record.artwork);
			row.classList.add('offline-row');
			const actions = document.createElement('div');
			actions.className = 'row-actions';
			const play = document.createElement('button');
			play.type = 'button';
			play.className = 'small-button primary-small';
			play.textContent = 'Play';
			play.setAttribute('aria-label', `Play ${record.track.title} offline`);
			play.addEventListener('click', () => void this.playOffline(records, index));
			const remove = document.createElement('button');
			remove.type = 'button';
			remove.className = 'small-button danger-small';
			remove.textContent = 'Remove';
			remove.setAttribute('aria-label', `Remove ${record.track.title} from offline`);
			remove.addEventListener('click', () => void this.removeOfflineTrack(record.id));
			actions.append(play, remove);
			row.append(actions);
			list.append(row);
		}
	}

	private createTrackRow(track: Track, artwork?: Blob): HTMLElement {
		const row = document.createElement('article');
		row.className = 'track-row';
		const image = document.createElement('img');
		image.className = 'row-artwork';
		image.alt = '';
		image.loading = 'lazy';
		if (artwork) {
			const objectUrl = URL.createObjectURL(artwork);
			this.listObjectUrls.push(objectUrl);
			image.src = objectUrl;
		} else if (track.artworkUrl) {
			image.src = track.artworkUrl;
		} else {
			image.classList.add('is-placeholder');
		}
		const copy = document.createElement('div');
		copy.className = 'row-copy';
		const title = document.createElement('strong');
		title.textContent = track.title;
		const artist = document.createElement('span');
		artist.textContent = artistNames(track);
		const album = document.createElement('small');
		album.textContent = track.album?.title || 'Unknown album';
		copy.append(title, artist, album);
		row.append(image, copy);
		return row;
	}

	private async playOffline(records: CachedTrackMetadata[], index: number): Promise<void> {
		const navigation = ++this.navigationVersion;
		this.resumeAfterNavigation = false;
		this.audio.stop();
		this.audio.primeForUserGesture();
		this.offlinePlayback = { records, index };
		this.feedbackStartedTrackId = undefined;
		this.showScreen('player');
		this.renderPlayer();
		await this.prepareCurrent();
		if (navigation !== this.navigationVersion) return;
		if (this.audio.trackId === this.currentTrack?.id) await this.audio.play();
		else {
			this.audio.stop();
			this.showError('The download could not be opened.');
		}
	}

	private async removeOfflineTrack(id: string): Promise<void> {
		this.manuallyRemovedCacheIds.add(id);
		this.cache.cancel();
		if (this.offlinePlayback) {
			const removedIndex = this.offlinePlayback.records.findIndex((record) => record.id === id);
			if (removedIndex === this.offlinePlayback.index) {
				this.navigationVersion += 1;
				this.resumeAfterNavigation = false;
				this.audio.stop();
				this.offlinePlayback = undefined;
				this.renderPlayer();
			} else if (removedIndex >= 0) {
				this.offlinePlayback.records.splice(removedIndex, 1);
				if (removedIndex < this.offlinePlayback.index) this.offlinePlayback.index -= 1;
				this.renderPlayer();
			}
		}
		await this.offlineStore.remove(id);
		await this.renderOfflineList();
		this.showToast('Offline track removed');
		if (this.connected && !this.offlinePlayback) void this.ensureQueueAndCache();
	}

	private async removeAllOffline(): Promise<void> {
		const confirmed = window.confirm('Remove every downloaded track and its artwork?');
		if (!confirmed) return;
		this.cache.cancel();
		for (const id of await this.offlineStore.ids()) this.manuallyRemovedCacheIds.add(id);
		if (this.offlinePlayback) {
			this.navigationVersion += 1;
			this.resumeAfterNavigation = false;
			this.audio.stop();
			this.offlinePlayback = undefined;
			this.renderPlayer();
		}
		await this.offlineStore.clear();
		await this.renderOfflineList();
		this.showToast('All offline tracks removed');
	}

	private async refreshOfflineSummary(knownCount?: number, knownBytes?: number): Promise<void> {
		const records = knownCount === undefined ? await this.offlineStore.list() : undefined;
		const count = knownCount ?? records?.length ?? 0;
		const bytes = knownBytes ?? (await this.offlineStore.usageBytes());
		this.element<HTMLElement>('offline-badge').textContent = String(count);
		this.element<HTMLElement>('offline-badge').hidden = count === 0;
		this.element<HTMLElement>('offline-nav-label').setAttribute('aria-label', `Offline, ${count} tracks, ${formatBytes(bytes)}`);
	}

	private updateOfflineTrackCount(value: string): void {
		const next = normalizeOfflineTrackCount(value);
		this.cacheAheadCount = next;
		saveOfflineTrackCount(next);
		this.renderOfflinePreference();
		if (this.connected && !this.offlinePlayback) void this.ensureQueueAndCache();
		this.showToast(
			next === 0
				? 'Automatic offline saving is off'
				: `Offline limit set to ${next} track${next === 1 ? '' : 's'}`,
		);
	}

	private updateKeepOfflineTracks(value: boolean): void {
		this.keepOfflineTracks = saveKeepOfflineTracks(value);
		this.renderOfflinePreference();
		if (this.connected && !this.offlinePlayback) void this.ensureQueueAndCache();
	}

	private renderOfflinePreference(): void {
		this.element<HTMLInputElement>('offline-track-count').value = String(this.cacheAheadCount);
		this.element<HTMLInputElement>('keep-offline-tracks').checked = this.keepOfflineTracks;
		let preferenceHelp: string;
		if (this.cacheAheadCount === 0) {
			preferenceHelp = this.keepOfflineTracks
				? 'Automatic offline saving is disabled. Existing downloads stay until you remove them.'
				: 'Automatic offline saving is disabled. Existing downloads stay until the online queue is refreshed.';
		} else {
			preferenceHelp = `The next ${this.cacheAheadCount} recommendation${this.cacheAheadCount === 1 ? '' : 's'} will be stored with artwork while the app is open.`;
		}
		this.element<HTMLElement>('offline-preference-help').textContent = preferenceHelp;
		this.element<HTMLElement>('offline-empty-message').textContent =
			this.cacheAheadCount === 0
				? 'Automatic offline saving is disabled in Preferences.'
				: `The next ${this.cacheAheadCount} recommendation${this.cacheAheadCount === 1 ? ' is' : 's are'} saved automatically while this app is open.`;
		let retentionHelp = 'Tracks outside the upcoming recommendation queue are removed automatically.';
		if (this.keepOfflineTracks) {
			retentionHelp =
				this.cacheAheadCount === 0
					? 'Existing offline tracks stay until you remove them.'
					: 'Automatic caching only adds tracks. Use Offline to remove them.';
		}
		this.element<HTMLElement>('offline-retention-help').textContent = retentionHelp;
	}

	private onCacheProgress(progress: CacheProgress): void {
		if ('error' in progress) this.showError(progress.error);
		if (progress.completed) {
			void this.refreshOfflineSummary();
			if (this.preparedNext?.kind === 'remote' && this.nextTrack?.id === progress.completed.id) {
				this.invalidatePreparedNext();
				void this.prepareNextPlayback();
			}
		}
		if (this.screen === 'offline' && progress.completed) void this.renderOfflineList();
	}

	private async refreshConnection(): Promise<void> {
		if (this.connecting) return;
		const wasConnected = this.connected;
		this.setSettingsBusy(true);
		this.setSettingsMessage('Checking proxy configuration…');
		try {
			const configured = await this.settings.status();
			if (!configured) {
				this.clearOnlineSession();
				this.setSettingsMessage(
					'No server-side Yandex Music token was found. For AWS, run scripts/set-token.sh from the deployment checkout, then check again.',
					true,
				);
				return;
			}
			if (this.connected) {
				this.setSettingsMessage('The proxy is configured and already connected.');
				this.showToast('Connection is ready');
				return;
			}
			await this.connect();
			this.showToast('Connected to Yandex Music');
		} catch (error) {
			if (wasConnected) this.setSettingsMessage(toMessage(error), true);
			else this.handleConnectionError(error);
			if (wasConnected) this.showError(error);
		} finally {
			this.setSettingsBusy(false);
		}
	}

	private clearOnlineSession(): void {
		this.connected = false;
		this.account = undefined;
		this.navigationVersion += 1;
		this.prepareVersion += 1;
		this.resumeAfterNavigation = false;
		this.feedbackStartedTrackId = undefined;
		this.reactionTrackId = undefined;
		this.cache.cancel();
		this.recommendations.reset();
		this.resetLikedTracks();
		if (!this.offlinePlayback) {
			this.audio.stop();
			this.renderPlayer();
		}
	}

	private handleConnectionError(error: unknown): void {
		this.connected = false;
		const message = navigator.onLine ? toMessage(error) : 'You are offline. Open Offline to play downloaded tracks.';
		this.setPlayerStatus(message);
		this.setSettingsMessage(message, true);
		this.showScreen(navigator.onLine ? 'settings' : 'offline');
		if (!navigator.onLine) void this.renderOfflineList();
		this.showError(error);
	}

	private requireConnection(): void {
		this.showError('Configure the token in AWS, then check the connection in Preferences.');
		this.showScreen('settings');
	}

	private showScreen(screen: Screen): void {
		this.screen = screen;
		let activeView: HTMLElement | undefined;
		this.root.querySelectorAll<HTMLElement>('[data-view]').forEach((view) => {
			view.hidden = view.dataset.view !== screen;
			if (!view.hidden) activeView = view;
		});
		this.root.querySelectorAll<HTMLElement>('[data-screen]').forEach((button) => {
			if (button.dataset.screen === screen) button.setAttribute('aria-current', 'page');
			else button.removeAttribute('aria-current');
		});
		if (screen !== 'liked' && screen !== 'offline') this.releaseListObjectUrls();
		window.scrollTo(0, 0);
		activeView?.focus({ preventScroll: true });
		if (screen === 'settings') {
			void this.renderCommitHistory();
			void this.renderStorageCapacity();
		}
	}

	private async renderStorageCapacity(): Promise<void> {
		const version = ++this.storageCapacityVersion;
		const row = this.element<HTMLElement>('storage-capacity');
		row.hidden = true;
		if (isIphoneIos15UserAgent(navigator.userAgent)) return;
		const capacity = await estimateStorageCapacity();
		if (version !== this.storageCapacityVersion || this.screen !== 'settings' || !capacity) return;
		this.element<HTMLElement>('storage-capacity-value').textContent =
			`${formatBytes(capacity.availableBytes)} available · ${formatBytes(capacity.quotaBytes)} quota`;
		row.hidden = false;
	}

	private async renderCommitHistory(): Promise<void> {
		if (this.commitHistoryRequested) return;
		this.commitHistoryRequested = true;
		const container = this.element<HTMLElement>('commit-history');
		try {
			const commits = await loadGithubHistory();
			const list = document.createElement('ul');
			list.className = 'commit-list';
			for (const commit of commits) {
				const item = document.createElement('li');
				const link = document.createElement('a');
				link.href = commit.url;
				link.target = '_blank';
				link.rel = 'noopener noreferrer';
				link.textContent = commit.shortSha;
				item.append(
					link,
					document.createTextNode(
						` · v${commit.version} · ${commit.date} · ${commit.subject}`,
					),
				);
				list.append(item);
			}
			container.replaceChildren(list);
		} catch (error) {
			const message = document.createElement('p');
			message.className = 'settings-message';
			message.textContent = 'Could not load commits.';
			container.replaceChildren(message);
			this.showError(error);
		}
	}

	private setPlayerStatus(message: string): void {
		this.element<HTMLElement>('player-status').textContent = message;
		this.element<HTMLElement>('empty-player-status').textContent = message;
	}

	private setSettingsMessage(message: string, error = false): void {
		const element = this.element<HTMLElement>('settings-message');
		element.textContent = message;
		element.classList.toggle('error-text', error);
	}

	private setSettingsBusy(busy: boolean): void {
		this.element<HTMLButtonElement>('refresh-connection').disabled = busy;
	}

	private showToast(message: string): void {
		const toast = this.element<HTMLElement>('toast');
		toast.textContent = message;
		toast.classList.add('is-visible');
		window.setTimeout(() => toast.classList.remove('is-visible'), 3_500);
	}

	private showError(error: unknown): void {
		const text = formatErrorText(error);
		const popup = this.element<HTMLElement>('error-popup');
		if (!popup.hidden) {
			const lastQueued = this.errorQueue[this.errorQueue.length - 1];
			if (text !== this.activeErrorText && text !== lastQueued) this.errorQueue.push(text);
			this.renderErrorCloseLabel();
			return;
		}
		this.activeErrorText = text;
		const message = this.element<HTMLElement>('error-popup-message');
		message.textContent = text;
		message.scrollTop = 0;
		const activeElement = document.activeElement;
		this.errorPopupPreviousFocus = activeElement instanceof HTMLElement ? activeElement : undefined;
		popup.hidden = false;
		this.renderErrorCloseLabel();
		this.element<HTMLButtonElement>('error-popup-close').focus({ preventScroll: true });
	}

	private closeErrorPopup(): void {
		const next = this.errorQueue.shift();
		if (next !== undefined) {
			this.activeErrorText = next;
			const message = this.element<HTMLElement>('error-popup-message');
			message.textContent = next;
			message.scrollTop = 0;
			this.renderErrorCloseLabel();
			return;
		}
		this.activeErrorText = undefined;
		this.element<HTMLElement>('error-popup').hidden = true;
		this.renderErrorCloseLabel();
		const previousFocus = this.errorPopupPreviousFocus;
		this.errorPopupPreviousFocus = undefined;
		if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
	}

	private renderErrorCloseLabel(): void {
		this.element<HTMLButtonElement>('error-popup-close').textContent = this.errorQueue.length ? 'Next error' : 'Close';
	}

	private trapErrorPopupFocus(event: KeyboardEvent): void {
		const close = this.element<HTMLButtonElement>('error-popup-close');
		const message = this.element<HTMLElement>('error-popup-message');
		if (event.shiftKey && document.activeElement === close) {
			event.preventDefault();
			message.focus({ preventScroll: true });
		} else if (!event.shiftKey && document.activeElement === message) {
			event.preventDefault();
			close.focus({ preventScroll: true });
		}
	}

	private installMediaSessionHandlers(): void {
		if (!('mediaSession' in navigator)) return;
		const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
			play: () => void this.resumePlayback(),
			pause: () => {
				this.resumeAfterNavigation = false;
				this.audio.pause();
			},
			previoustrack: () => void this.previous(),
			nexttrack: () => void this.next(true),
			seekto: (details) => {
				if (details.seekTime !== undefined) this.audio.seek(details.seekTime);
			},
		};
		for (const [action, handler] of Object.entries(handlers)) {
			try {
				navigator.mediaSession.setActionHandler(action as MediaSessionAction, handler ?? null);
			} catch {
				// Older Safari versions expose only a subset of Media Session actions.
			}
		}
	}

	private updateMediaMetadata(track: Track, artworkUrl = track.artworkUrl): void {
		if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
		const artwork = artworkUrl ? [{ src: artworkUrl, sizes: '400x400' }] : [];
		try {
			navigator.mediaSession.metadata = new MediaMetadata({
				title: track.title,
				artist: artistNames(track),
				album: track.album?.title ?? '',
				artwork,
			});
		} catch {
			// Broken artwork must not prevent lock-screen title and artist metadata.
			try {
				navigator.mediaSession.metadata = new MediaMetadata({
					title: track.title,
					artist: artistNames(track),
					album: track.album?.title ?? '',
				});
			} catch {
				// Media Session is optional on early Safari 15 builds.
			}
		}
	}

	private syncMediaSession(): void {
		const track = this.currentTrack;
		if (!track) return;
		this.updateMediaMetadata(track, this.currentArtworkUrl);
		this.updateMediaPosition(this.audio.currentTime, track.durationMs / 1_000);
	}

	private updateMediaPosition(current: number, duration: number): void {
		if (!('mediaSession' in navigator) || !Number.isFinite(duration) || duration <= 0) return;
		try {
			navigator.mediaSession.setPositionState({
				duration,
				playbackRate: 1,
				position: Math.max(0, Math.min(current, duration)),
			});
		} catch {
			// Safari 15 implements Media Session incrementally across point releases.
		}
	}

	private renderTrackLinks(track: Track): void {
		const links: ReadonlyArray<[string, string]> = [
			['yandex-link', yandexMusicTrackUrl(track)],
			['genius-link', geniusTrackSearchUrl(track)],
			['lastfm-link', lastFmTrackSearchUrl(track)],
			['wikipedia-link', wikipediaArtistSearchUrl(track)],
			['youtube-link', youtubeTrackSearchUrl(track)],
			['google-link', googleTrackSearchUrl(track)],
			['musicbrainz-track-link', musicBrainzTrackSearchUrl(track)],
			['musicbrainz-album-link', musicBrainzAlbumSearchUrl(track)],
			['musicbrainz-artist-link', musicBrainzArtistSearchUrl(track)],
			['wikidata-track-link', wikidataTrackSearchUrl(track)],
			['wikidata-album-link', wikidataAlbumSearchUrl(track)],
			['wikidata-artist-link', wikidataArtistSearchUrl(track)],
		];
		for (const [id, href] of links) this.element<HTMLAnchorElement>(id).href = href;
	}

	private shareCurrent(): void {
		const track = this.currentTrack;
		if (!track) return;
		const url = yandexMusicTrackUrl(track);
		const title = `${track.title} — ${artistNames(track)}`;
		if (typeof navigator.share === 'function') {
			try {
				void navigator.share({ title, text: title, url }).catch((error: unknown) => {
					if (!(error instanceof DOMException && error.name === 'AbortError')) {
						this.showError(error);
					}
				});
			} catch (error) {
				this.showError(error);
			}
			return;
		}
		if (navigator.clipboard?.writeText) {
			void navigator.clipboard.writeText(url).then(
				() => this.showToast('Yandex Music link copied'),
				() => window.open(url, '_blank', 'noopener,noreferrer'),
			);
			return;
		}
		window.open(url, '_blank', 'noopener,noreferrer');
	}

	private async downloadCurrent(): Promise<void> {
		const track = this.currentTrack;
		if (!track || this.downloadingTrackId) return;
		const ready = this.preparedDownload?.trackId === track.id ? this.preparedDownload : undefined;
		if (ready) {
			this.saveAudioFile(ready.file, track);
			return;
		}
		if (this.currentAudioBlob) {
			const file = createAudioFile(track, this.currentAudioBlob, this.currentMediaSource?.codec);
			this.preparedDownload = { trackId: track.id, file };
			this.saveAudioFile(file, track);
			return;
		}

		const version = ++this.downloadVersion;
		const controller = new AbortController();
		this.downloadController = controller;
		this.downloadingTrackId = track.id;
		this.renderDownloadButton(track);
		try {
			const cached = await this.offlineStore.get(track.id);
			let source = this.currentMediaSource;
			let audio = cached?.audio;
			if (!audio) {
				if (!navigator.onLine) throw new Error('This track is not available offline.');
				source ??= await this.media.resolve(track.id);
				audio = await downloadMediaBlob(source, controller.signal);
			}
			if (version !== this.downloadVersion || this.currentTrack?.id !== track.id) return;
			this.currentAudioBlob = audio;
			this.currentMediaSource = source;
			const file = createAudioFile(track, audio, source?.codec ?? cached?.media?.codec);
			this.preparedDownload = { trackId: track.id, file };
			if (canShareFiles(file)) {
				this.showToast('Audio is ready. Tap Save file to choose where to save it.');
			} else {
				triggerFileDownload(file);
			}
		} catch (error) {
			if (version === this.downloadVersion && !(error instanceof DOMException && error.name === 'AbortError')) {
				this.showError(error);
			}
		} finally {
			if (this.downloadController === controller) this.downloadController = undefined;
			if (this.downloadingTrackId === track.id) this.downloadingTrackId = undefined;
			if (this.currentTrack?.id === track.id) this.renderDownloadButton(track);
		}
	}

	private saveAudioFile(file: File, track: Track): void {
		if (canShareFiles(file)) {
			try {
				void navigator.share({ files: [file], title: `${track.title} — ${artistNames(track)}` }).catch((error: unknown) => {
					if (!(error instanceof DOMException && error.name === 'AbortError')) {
						this.showError(error);
					}
				});
			} catch (error) {
				this.showError(error);
			}
			return;
		}
		triggerFileDownload(file);
	}

	private renderDownloadButton(track: Track): void {
		const button = this.element<HTMLButtonElement>('download-button');
		const loading = this.downloadingTrackId === track.id;
		button.disabled = loading;
		let label = 'Download';
		if (loading) label = 'Preparing…';
		else if (this.preparedDownload?.trackId === track.id) label = 'Save file';
		button.textContent = label;
	}

	private resetCurrentMedia(trackId: string): void {
		this.downloadVersion += 1;
		this.downloadController?.abort();
		this.downloadController = undefined;
		this.downloadingTrackId = undefined;
		this.currentAudioBlob = undefined;
		this.currentMediaSource = undefined;
		if (this.preparedDownload?.trackId !== trackId) this.preparedDownload = undefined;
	}

	private releaseListObjectUrls(): void {
		for (const url of this.listObjectUrls) URL.revokeObjectURL(url);
		this.listObjectUrls = [];
	}

	private element<T extends HTMLElement>(id: string): T {
		const element = this.root.querySelector<T>(`#${id}`);
		if (!element) throw new Error(`Missing UI element: ${id}`);
		return element;
	}
}

function installGlobalErrorHandlers(reporter: (error: unknown) => void): void {
	activeGlobalErrorReporter = reporter;
	if (globalErrorHandlersInstalled) return;
	globalErrorHandlersInstalled = true;
	window.addEventListener('error', (event) => {
		const location = event.filename
			? `\nSource: ${event.filename}:${event.lineno || 0}:${event.colno || 0}`
			: '';
		reportGlobalError(event.error ?? `${event.message || 'Unknown JavaScript error.'}${location}`);
	});
	window.addEventListener('unhandledrejection', (event) => {
		reportGlobalError(event.reason ?? 'Unhandled promise rejection.');
	});
}

function reportGlobalError(error: unknown): void {
	if (!activeGlobalErrorReporter || reportingGlobalError) return;
	reportingGlobalError = true;
	try {
		activeGlobalErrorReporter(error);
	} finally {
		reportingGlobalError = false;
	}
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Something went wrong.';
}

function codecFromMime(mime: string): string {
	const normalized = mime.toLowerCase();
	if (normalized.includes('flac')) return 'flac';
	if (normalized.includes('mpeg')) return 'mp3';
	if (normalized.includes('mp4')) return 'aac-mp4';
	if (normalized.includes('aac')) return 'aac';
	return 'audio';
}

function createAudioFile(track: Track, audio: Blob, codec = codecFromMime(audio.type)): File {
	const extension = audioExtension(codec);
	const type = audio.type.startsWith('audio/') ? audio.type : audioMime(extension);
	const baseName = `${artistNames(track)} - ${track.title}`
		.replace(/[\\/:*?"<>|]+/g, '-')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 180) || 'track';
	return new File([audio], `${baseName}.${extension}`, { type });
}

function audioExtension(codec: string): string {
	const normalized = codec.toLowerCase();
	if (normalized.includes('mp4')) return 'm4a';
	if (normalized.includes('flac')) return 'flac';
	if (normalized.includes('mp3')) return 'mp3';
	if (normalized.includes('aac')) return 'aac';
	return 'audio';
}

function audioMime(extension: string): string {
	if (extension === 'm4a') return 'audio/mp4';
	if (extension === 'mp3') return 'audio/mpeg';
	if (extension === 'flac') return 'audio/flac';
	if (extension === 'aac') return 'audio/aac';
	return 'application/octet-stream';
}

function canShareFiles(file: File): boolean {
	if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
	try {
		return navigator.canShare({ files: [file] });
	} catch {
		return false;
	}
}

function triggerFileDownload(file: File): void {
	const url = URL.createObjectURL(file);
	const link = document.createElement('a');
	link.href = url;
	link.download = file.name;
	link.hidden = true;
	document.body.append(link);
	link.click();
	link.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function template(): string {
	return `
		<div class="app-shell">
			<header class="topbar">
				<nav class="main-nav" aria-label="Main navigation">
					<button type="button" data-screen="player"><span aria-hidden="true">▶</span><span>Player</span></button>
					<button type="button" data-screen="liked"><span aria-hidden="true">♡</span><span>Liked</span></button>
					<button type="button" data-screen="offline" id="offline-nav-label">
						<span aria-hidden="true">↓</span><span>Offline</span><b id="offline-badge" class="badge" hidden>0</b>
					</button>
					<button type="button" data-screen="settings"><span aria-hidden="true">⚙</span><span>Preferences</span></button>
				</nav>
			</header>

			<main>
				<section class="player-view" data-view="player" tabindex="-1" aria-labelledby="track-title">
					<div id="player-empty" class="empty-player">
						<div class="empty-disc" aria-hidden="true"></div>
						<h1>Your recommendations</h1>
						<p id="empty-player-status">Connect Yandex Music to start My Wave.</p>
						<button type="button" class="primary-button" data-screen="settings">Open Preferences</button>
					</div>
					<div id="player-content" class="player-content" hidden>
						<div class="artwork-column">
							<div class="artwork-frame">
								<img id="artwork" alt="" draggable="false" />
								<div id="artwork-placeholder" class="artwork-placeholder" aria-hidden="true"><span></span></div>
							</div>
						</div>
						<div class="player-copy">
							<p id="source-label" class="eyebrow" hidden></p>
							<h1 id="track-title">—</h1>
							<dl class="track-details">
								<div><dt>Artist</dt><dd id="track-artist">—</dd></div>
								<div><dt>Album</dt><dd id="track-album">—</dd></div>
							</dl>
							<p id="player-status" class="player-status">Recommended for you</p>
							<div class="track-action-row">
								<button id="download-button" type="button" class="track-action-button">Download</button>
								<button id="share-button" type="button" class="track-action-button">Share</button>
							</div>
							<details id="track-searches" class="track-searches">
								<summary>Search</summary>
								<nav class="track-links" aria-label="Track links">
									<a id="yandex-link" target="_blank" rel="noopener noreferrer">Yandex</a>
									<a id="genius-link" target="_blank" rel="noopener noreferrer">Genius</a>
									<a id="lastfm-link" target="_blank" rel="noopener noreferrer">Last.fm</a>
									<a id="wikipedia-link" target="_blank" rel="noopener noreferrer">Wikipedia</a>
									<a id="youtube-link" target="_blank" rel="noopener noreferrer">YouTube</a>
									<a id="google-link" target="_blank" rel="noopener noreferrer">Google</a>
									<a id="musicbrainz-track-link" target="_blank" rel="noopener noreferrer">MusicBrainz track</a>
									<a id="musicbrainz-album-link" target="_blank" rel="noopener noreferrer">MusicBrainz album</a>
									<a id="musicbrainz-artist-link" target="_blank" rel="noopener noreferrer">MusicBrainz artist</a>
									<a id="wikidata-track-link" target="_blank" rel="noopener noreferrer">Wikidata track</a>
									<a id="wikidata-album-link" target="_blank" rel="noopener noreferrer">Wikidata album</a>
									<a id="wikidata-artist-link" target="_blank" rel="noopener noreferrer">Wikidata artist</a>
								</nav>
							</details>
							<div class="reaction-row">
								<button id="dislike-button" type="button" class="reaction-button dislike" aria-label="Dislike this track" aria-pressed="false"><span aria-hidden="true">−</span> Dislike</button>
								<button id="like-button" type="button" class="reaction-button like" aria-label="Like this track" aria-pressed="false"><span aria-hidden="true">♥</span> Like</button>
							</div>
							<div class="timeline">
								<input id="progress" type="range" min="0" max="0" value="0" aria-label="Playback position" />
								<div><span id="elapsed">0:00</span><span id="duration">0:00</span></div>
							</div>
							<div class="transport-controls">
								<button id="previous-button" type="button" aria-label="Previous track"><span aria-hidden="true">‹</span></button>
								<button id="play-button" class="play-button" type="button" aria-label="Play">
									<span data-play aria-hidden="true">▶</span><span data-pause aria-hidden="true" hidden>Ⅱ</span>
								</button>
								<button id="next-button" type="button" aria-label="Next track"><span aria-hidden="true">›</span></button>
							</div>
						</div>
					</div>
				</section>

				<section class="library-view" data-view="liked" tabindex="-1" hidden aria-labelledby="liked-title">
					<div class="section-heading"><div><p class="eyebrow">Your library</p><h1 id="liked-title">Liked tracks</h1><p id="liked-message">Loading liked tracks…</p></div></div>
					<div id="liked-list" class="track-list"></div>
					<button id="liked-more" type="button" class="secondary-button" hidden>Show more</button>
				</section>

				<section class="library-view" data-view="offline" tabindex="-1" hidden aria-label="Offline">
					<div class="section-heading">
						<div><p class="eyebrow">On this device</p><p id="offline-usage">0 tracks · 0 B</p></div>
						<button id="remove-all" type="button" class="danger-button" disabled>Remove all</button>
					</div>
					<div id="offline-empty" class="empty-library"><div aria-hidden="true">↓</div><h2>No downloads yet</h2><p id="offline-empty-message">Recommendations are saved automatically while this app is open.</p></div>
					<div id="offline-list" class="track-list"></div>
				</section>

				<section class="settings-view" data-view="settings" tabindex="-1" hidden aria-label="Preferences">
					<div class="settings-card">
						<button id="settings-back" type="button" class="back-button"><span aria-hidden="true">‹</span> Back</button>
						<div class="settings-control">
							<label for="offline-track-count">Tracks to keep offline</label>
							<input id="offline-track-count" type="number" min="0" max="50" step="1" inputmode="numeric" aria-describedby="offline-preference-help" />
							<p id="offline-preference-help"></p>
							<label class="retention-preference" for="keep-offline-tracks">
								<input id="keep-offline-tracks" type="checkbox" aria-describedby="offline-retention-help" />
								<span>Do not remove offline tracks</span>
							</label>
							<p id="offline-retention-help"></p>
						</div>
						<dl id="storage-capacity" class="storage-capacity" hidden>
							<div><dt>Estimated space left</dt><dd id="storage-capacity-value">—</dd></div>
						</dl>
						<div class="settings-actions"><button id="refresh-connection" type="button" class="primary-button">Check connection</button></div>
						<p id="settings-message" class="settings-message" role="status"></p>
						<section class="version-history" aria-labelledby="commit-history-title">
							<h2 id="commit-history-title">Last 10 commits</h2>
							<div id="commit-history"><p class="settings-message">Loading…</p></div>
							<p class="current-version"><span id="app-version">Version</span> · <a href="https://github.com/vitaly-zdanevich/yandex-music-pwa" target="_blank" rel="noopener noreferrer">source</a></p>
						</section>
					</div>
				</section>
			</main>
			<div id="error-popup" class="error-popup" hidden>
				<section class="error-popup-card" role="alertdialog" aria-modal="true" aria-labelledby="error-popup-title" aria-describedby="error-popup-message">
					<header>
						<h2 id="error-popup-title">Error</h2>
						<button id="error-popup-close" type="button">Close</button>
					</header>
					<pre id="error-popup-message" tabindex="0"></pre>
				</section>
			</div>
			<div id="toast" class="toast" role="status" aria-live="polite"></div>
		</div>`;
}
