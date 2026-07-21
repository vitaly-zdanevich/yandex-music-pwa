import { CacheCoordinator, type CacheProgress } from './adapters/cache-coordinator';
import { HttpMusicTransport } from './adapters/http-transport';
import { ProxyMediaResolver } from './adapters/media-resolver';
import { IndexedDbOfflineStore, type CachedTrackMetadata } from './adapters/offline-store';
import { SettingsClient } from './adapters/settings-client';
import { artistNames, formatBytes, formatTime } from './lib/format';
import { AudioPlayer } from './player/audio-player';
import {
  RecommendationSession,
  selectTracksToCache,
  type Account,
  type FeedbackType,
  type LikedTrackPage,
  type RecommendedTrack,
  type Track,
  YandexMusicClient,
} from './sdk';

type Screen = 'player' | 'liked' | 'offline' | 'settings';

const CACHE_AHEAD_COUNT = 10;
const LIBRARY_PAGE_SIZE = 100;

export class App {
  private readonly transport = new HttpMusicTransport();
  private readonly client = new YandexMusicClient(this.transport);
  private readonly recommendations = new RecommendationSession(this.client);
  private readonly offlineStore = new IndexedDbOfflineStore();
  private readonly media = new ProxyMediaResolver();
  private readonly settings = new SettingsClient();
  private readonly cache = new CacheCoordinator(this.offlineStore, this.media, (progress) => this.onCacheProgress(progress));
  private readonly audio = new AudioPlayer({
    onEnded: () => void this.onEnded(),
    onError: (message) => this.showToast(message, 'error'),
    onPlayState: (playing) => this.onPlayState(playing),
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
  private cacheProgress?: CacheProgress;
  private readonly manuallyRemovedCacheIds = new Set<string>();
  private navigationVersion = 0;
  private resumeAfterNavigation = false;
  private reactionTrackId?: string;
  private offlineRenderVersion = 0;

  constructor(private readonly root: HTMLElement) {}

  async init(): Promise<void> {
    this.root.innerHTML = template();
    this.bindEvents();
    await this.refreshOfflineSummary();
    this.renderPlayer();
    let configured = false;
    let statusError: string | undefined;
    try {
      configured = await this.settings.status();
    } catch (error) {
      statusError = toMessage(error);
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
          statusError ?? 'No server-side Yandex Music token was found. For AWS, add it from your deployment terminal, then check again.',
          true,
        );
      }
    }
  }

  private bindEvents(): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-screen]').forEach((button) => {
      button.addEventListener('click', () => {
        const screen = button.dataset.screen as Screen;
        if (screen === 'liked') void this.openLiked();
        else if (screen === 'offline') void this.openOffline();
        else if (screen === 'player') this.openPlayer();
        else this.showScreen(screen);
      });
    });
    this.element<HTMLButtonElement>('play-button').addEventListener('click', () => {
      if (this.audio.trackId !== this.currentTrack?.id) this.audio.primeForUserGesture();
      void this.togglePlayback();
    });
    this.element<HTMLButtonElement>('previous-button').addEventListener('click', () => void this.previous());
    this.element<HTMLButtonElement>('next-button').addEventListener('click', () => void this.next(true));
    this.element<HTMLButtonElement>('like-button').addEventListener('click', () => void this.toggleLike());
    this.element<HTMLButtonElement>('dislike-button').addEventListener('click', () => void this.dislike());
    this.element<HTMLInputElement>('progress').addEventListener('input', (event) => {
      this.audio.seek(Number((event.currentTarget as HTMLInputElement).value));
    });
    this.element<HTMLButtonElement>('refresh-connection').addEventListener('click', () => void this.refreshConnection());
    this.element<HTMLButtonElement>('remove-all').addEventListener('click', () => void this.removeAllOffline());
    this.element<HTMLButtonElement>('liked-more').addEventListener('click', () => void this.loadNextLikedPage());
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

  private async ensureQueueAndCache(): Promise<void> {
    if (!this.connected || this.offlinePlayback || !navigator.onLine) return;
    try {
      await this.recommendations.ensureUpcoming(CACHE_AHEAD_COUNT);
      const horizon = this.recommendations.upcoming(CACHE_AHEAD_COUNT);
      const horizonIds = new Set(horizon.map((item) => item.track.id));
      await this.offlineStore.prune(horizonIds);
      const cachedIds = await this.offlineStore.ids();
      for (const id of this.manuallyRemovedCacheIds) {
        if (!horizonIds.has(id)) this.manuallyRemovedCacheIds.delete(id);
        else cachedIds.add(id);
      }
      this.cache.replace(selectTracksToCache(horizon, cachedIds, CACHE_AHEAD_COUNT));
      void this.refreshOfflineSummary();
      this.renderPlayer();
    } catch (error) {
      this.showToast(toMessage(error), 'error');
    }
  }

  private get currentTrack(): Track | undefined {
    return this.offlinePlayback
      ? this.offlinePlayback.records[this.offlinePlayback.index]?.track
      : this.recommendations.current?.track;
  }

  private get currentRecommended(): RecommendedTrack | undefined {
    return this.offlinePlayback ? undefined : this.recommendations.current;
  }

  private renderPlayer(): void {
    const track = this.currentTrack;
    const hasTrack = Boolean(track);
    this.element<HTMLElement>('player-empty').hidden = hasTrack;
    this.element<HTMLElement>('player-content').hidden = !hasTrack;
    if (!track) {
      this.element<HTMLButtonElement>('previous-button').disabled = true;
      this.element<HTMLButtonElement>('next-button').disabled = true;
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
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
    this.element<HTMLElement>('source-label').textContent = this.offlinePlayback ? 'Offline download' : 'My Wave';
    this.element<HTMLElement>('cache-status').textContent = this.cacheStatusText();
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
    if (!track || this.audio.trackId === track.id) return;
    const version = ++this.prepareVersion;
    this.setPlayerStatus(this.offlinePlayback ? 'Opening download…' : 'Preparing track…');
    try {
      const cached = await this.offlineStore.get(track.id);
      if (version !== this.prepareVersion || this.currentTrack?.id !== track.id) return;
      if (cached) {
        this.audio.load(track, URL.createObjectURL(cached.audio), true);
        this.setPlayerStatus(this.offlinePlayback ? 'Available offline' : 'Playing the offline copy');
      } else {
        if (!navigator.onLine) throw new Error('This track is not downloaded. Open Offline to choose a cached track.');
        const source = await this.media.resolve(track.id);
        if (version !== this.prepareVersion || this.currentTrack?.id !== track.id) return;
        const fallback = source.proxyUrl && source.proxyUrl !== source.url ? source.proxyUrl : undefined;
        const usesProxy = source.proxyUrl === source.url;
        this.audio.load(track, source.url, false, fallback, usesProxy);
        this.setPlayerStatus(mediaQualityLabel(source.quality, source.codec, source.bitrate));
      }
    } catch (error) {
      this.setPlayerStatus(toMessage(error));
    }
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
      this.showToast('The track is not ready yet. Check your connection.', 'error');
      return;
    }
    if (this.audio.playing) {
      this.resumeAfterNavigation = false;
      this.audio.pause();
    } else {
      await this.audio.play();
    }
  }

  private async next(autoPlay: boolean, sendSkip = true): Promise<void> {
    const navigation = ++this.navigationVersion;
    if (!sendSkip || (autoPlay && (this.audio.playing || this.resumeAfterNavigation))) {
      this.resumeAfterNavigation = true;
    }
    if (this.offlinePlayback) {
      if (this.offlinePlayback.index + 1 >= this.offlinePlayback.records.length) {
        if (navigation === this.navigationVersion) this.resumeAfterNavigation = false;
        return;
      }
    } else if (this.recommendations.index + 1 >= this.recommendations.length) {
      await this.recommendations.ensureUpcoming(CACHE_AHEAD_COUNT);
      if (navigation !== this.navigationVersion) return;
      if (this.recommendations.index + 1 >= this.recommendations.length) {
        this.resumeAfterNavigation = false;
        this.showToast('No more recommendations are available right now.', 'error');
        return;
      }
    }

    const previous = this.currentRecommended;
    if (sendSkip && previous) void this.safeFeedback('skip', previous, this.audio.currentTime);
    this.audio.stop();
    this.feedbackStartedTrackId = undefined;

    if (this.offlinePlayback) {
      this.offlinePlayback.index += 1;
    } else {
      this.recommendations.next();
    }
    this.renderPlayer();
    await this.prepareCurrent();
    if (navigation !== this.navigationVersion) return;
    if (this.resumeAfterNavigation && this.audio.trackId === this.currentTrack?.id) await this.audio.play();
    if (navigation === this.navigationVersion) this.resumeAfterNavigation = false;
    if (!this.offlinePlayback) void this.ensureQueueAndCache();
  }

  private async previous(): Promise<void> {
    if (this.offlinePlayback ? this.offlinePlayback.index === 0 : this.recommendations.index === 0) return;
    const navigation = ++this.navigationVersion;
    if (this.audio.playing || this.resumeAfterNavigation) this.resumeAfterNavigation = true;
    const previous = this.currentRecommended;
    if (previous) void this.safeFeedback('skip', previous, this.audio.currentTime);
    this.audio.stop();
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
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    const current = this.currentRecommended;
    if (playing && current && this.feedbackStartedTrackId !== current.track.id) {
      this.feedbackStartedTrackId = current.track.id;
      void this.safeFeedback('trackStarted', current);
    }
  }

  private renderTime(current: number, duration: number): void {
    const progress = this.element<HTMLInputElement>('progress');
    progress.max = String(duration || 0);
    progress.value = String(Math.min(current, duration || current));
    this.element<HTMLElement>('elapsed').textContent = formatTime(current);
    this.element<HTMLElement>('duration').textContent = formatTime(duration);
  }

  private async toggleLike(): Promise<void> {
    const track = this.currentTrack;
    if (!track || !this.account) return this.requireConnection();
    if (this.reactionTrackId) return;
    const recommended = this.currentRecommended;
    this.reactionTrackId = track.id;
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
      this.showToast(liked ? 'Added to Liked' : 'Removed from Liked');
    } catch (error) {
      Object.assign(track, previous);
      this.renderPlayer();
      this.showToast(toMessage(error), 'error');
    } finally {
      if (this.reactionTrackId === track.id) this.reactionTrackId = undefined;
      if (this.currentTrack?.id === track.id) this.renderPlayer();
    }
  }

  private async dislike(): Promise<void> {
    const track = this.currentTrack;
    if (!track || !this.account) return this.requireConnection();
    if (this.reactionTrackId) return;
    const recommended = this.currentRecommended;
    this.reactionTrackId = track.id;
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
      this.showToast(toMessage(error), 'error');
    } finally {
      if (this.reactionTrackId === track.id) this.reactionTrackId = undefined;
      if (this.currentTrack?.id === track.id) this.renderPlayer();
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
      this.showToast('The download could not be opened.', 'error');
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

  private onCacheProgress(progress: CacheProgress): void {
    this.cacheProgress = progress;
    this.element<HTMLElement>('cache-status').textContent = this.cacheStatusText();
    if (progress.error) this.showToast(progress.error, 'error');
    if (progress.completed) void this.refreshOfflineSummary();
    if (this.screen === 'offline' && progress.completed) void this.renderOfflineList();
  }

  private cacheStatusText(): string {
    if (this.offlinePlayback) return 'Playing from this device';
    if (this.cacheProgress?.current) {
      return `Saving ${this.cacheProgress.current.title} · ${this.cacheProgress.pending} left`;
    }
    return navigator.onLine ? `Keeping the next ${CACHE_AHEAD_COUNT} tracks offline` : 'Offline';
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
      this.showToast(toMessage(error), 'error');
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
  }

  private requireConnection(): void {
    this.showToast('Configure the token in AWS, then check the connection in Preferences.', 'error');
    this.showScreen('settings');
  }

  private showScreen(screen: Screen): void {
    this.screen = screen;
    this.root.querySelectorAll<HTMLElement>('[data-view]').forEach((view) => {
      view.hidden = view.dataset.view !== screen;
    });
    this.root.querySelectorAll<HTMLElement>('[data-screen]').forEach((button) => {
      if (button.dataset.screen === screen) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (screen !== 'liked' && screen !== 'offline') this.releaseListObjectUrls();
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

  private showToast(message: string, kind: 'normal' | 'error' = 'normal'): void {
    const toast = this.element<HTMLElement>('toast');
    toast.textContent = message;
    toast.classList.toggle('is-error', kind === 'error');
    toast.classList.add('is-visible');
    window.setTimeout(() => toast.classList.remove('is-visible'), 3_500);
  }

  private installMediaSessionHandlers(): void {
    if (!('mediaSession' in navigator)) return;
    const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: () => void this.togglePlayback(),
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
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: artistNames(track),
      album: track.album?.title ?? '',
      artwork,
    });
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

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

function mediaQualityLabel(quality: string, codec: string, bitrate: number): string {
  const normalizedCodec = codec ? codec.toUpperCase() : 'audio';
  if (quality === 'lossless') return `Lossless · ${normalizedCodec}`;
  if (bitrate > 0) return `Highest available · ${normalizedCodec} · ${bitrate} kbps`;
  return `Highest available · ${normalizedCodec}`;
}

function template(): string {
  return `
    <div class="app-shell">
      <header class="topbar">
        <button class="brand" type="button" data-screen="player" aria-label="Open player">
          <span class="brand-mark" aria-hidden="true"><i></i></span>
          <span>My Wave</span>
        </button>
        <nav class="main-nav" aria-label="Main navigation">
          <button type="button" data-screen="liked"><span aria-hidden="true">♡</span><span>Liked</span></button>
          <button type="button" data-screen="offline" id="offline-nav-label">
            <span aria-hidden="true">↓</span><span>Offline</span><b id="offline-badge" class="badge" hidden>0</b>
          </button>
          <button type="button" data-screen="settings"><span aria-hidden="true">⚙</span><span>Preferences</span></button>
        </nav>
      </header>

      <main>
        <section class="player-view" data-view="player" aria-labelledby="track-title">
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
              <p id="cache-status" class="cache-status"></p>
            </div>
            <div class="player-copy">
              <p id="source-label" class="eyebrow">My Wave</p>
              <h1 id="track-title">—</h1>
              <dl class="track-details">
                <div><dt>Artist</dt><dd id="track-artist">—</dd></div>
                <div><dt>Album</dt><dd id="track-album">—</dd></div>
              </dl>
              <p id="player-status" class="player-status">Recommended for you</p>
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

        <section class="library-view" data-view="liked" hidden aria-labelledby="liked-title">
          <div class="section-heading"><div><p class="eyebrow">Your library</p><h1 id="liked-title">Liked tracks</h1><p id="liked-message">Loading liked tracks…</p></div></div>
          <div id="liked-list" class="track-list"></div>
          <button id="liked-more" type="button" class="secondary-button" hidden>Show more</button>
        </section>

        <section class="library-view" data-view="offline" hidden aria-labelledby="offline-title">
          <div class="section-heading">
            <div><p class="eyebrow">On this device</p><h1 id="offline-title">Offline</h1><p id="offline-usage">0 tracks · 0 B</p></div>
            <button id="remove-all" type="button" class="danger-button" disabled>Remove all</button>
          </div>
          <div id="offline-empty" class="empty-library"><div aria-hidden="true">↓</div><h2>No downloads yet</h2><p>The next 10 recommendations are saved automatically while this app is open.</p></div>
          <div id="offline-list" class="track-list"></div>
        </section>

        <section class="settings-view" data-view="settings" hidden aria-labelledby="settings-title">
          <div class="settings-card">
            <p class="eyebrow">Preferences</p>
            <h1 id="settings-title">Connect Yandex Music</h1>
            <p class="settings-intro">The proxy reads your OAuth token only from server-side configuration. This PWA never accepts, transmits, or stores it.</p>
            <div class="privacy-note"><strong>AWS deployment</strong><p>Store it in Systems Manager Parameter Store at <code>/&lt;project-name&gt;/yandex-token</code> with <code>scripts/set-token.sh</code>. Remove or rotate it there as well.</p></div>
            <div class="settings-actions"><button id="refresh-connection" type="button" class="primary-button">Check connection</button></div>
            <p id="settings-message" class="settings-message" role="status"></p>
          </div>
        </section>
      </main>
      <div id="toast" class="toast" role="status" aria-live="polite"></div>
    </div>`;
}
