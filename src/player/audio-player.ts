import type { Track } from '../sdk';

export interface PlayerEvents {
  onEnded: () => void;
  onError: (message: string) => void;
  onPlayState: (playing: boolean) => void;
  onTime: (currentSeconds: number, durationSeconds: number) => void;
}

export class AudioPlayer {
  private readonly audio = new Audio();
  private readonly silentSource = createSilentWavUrl();
  private objectUrl?: string;
  private loadedTrackId?: string;
  private fallbackUrl?: string;
  private fallbackAttempted = false;
  private wantsPlayback = false;
  private priming = false;
  private reportedPlaying = false;

  constructor(private readonly events: PlayerEvents) {
    this.audio.preload = 'auto';
    this.audio.setAttribute('playsinline', '');
    this.audio.addEventListener('ended', () => {
      if (!this.priming && this.loadedTrackId) {
        this.wantsPlayback = false;
        this.reportPlayState(false);
        events.onEnded();
      }
    });
    this.audio.addEventListener('pause', () => {
      if (!this.priming) this.reportPlayState(false);
    });
    this.audio.addEventListener('timeupdate', () =>
      events.onTime(this.audio.currentTime || 0, Number.isFinite(this.audio.duration) ? this.audio.duration : 0),
    );
    this.audio.addEventListener('durationchange', () =>
      events.onTime(this.audio.currentTime || 0, Number.isFinite(this.audio.duration) ? this.audio.duration : 0),
    );
    this.audio.addEventListener('error', () => void this.handleError());
  }

  get trackId(): string | undefined {
    return this.loadedTrackId;
  }

  get playing(): boolean {
    return !this.audio.paused;
  }

  get currentTime(): number {
    return this.audio.currentTime || 0;
  }

  /** Invoke synchronously from a tap before an IndexedDB/network await on iOS. */
  primeForUserGesture(): void {
    if (!this.loadedTrackId) {
      this.priming = true;
      this.setCorsMode(false);
      this.audio.src = this.silentSource;
      this.audio.load();
    }
    void this.audio.play().catch(() => {
      // The real play attempt reports a useful message after preparation.
    });
  }

  load(track: Track, source: string, isObjectUrl = false, fallbackUrl?: string, useCors = false): void {
    this.audio.pause();
    this.reportPlayState(false);
    this.priming = false;
    this.releaseObjectUrl();
    this.loadedTrackId = track.id;
    this.fallbackUrl = fallbackUrl;
    this.fallbackAttempted = false;
    this.wantsPlayback = false;
    this.setCorsMode(useCors);
    this.audio.src = source;
    if (isObjectUrl) this.objectUrl = source;
    this.audio.load();
  }

  async play(): Promise<void> {
    if (!this.loadedTrackId) {
      this.stop();
      this.events.onError('The track is not ready yet.');
      return;
    }
    this.wantsPlayback = true;
    try {
      await this.audio.play();
      this.reportPlayState(true);
    } catch (error) {
      const message = error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Tap play again to allow audio on this device.'
        : 'Playback could not start.';
      this.events.onError(message);
    }
  }

  pause(): void {
    this.wantsPlayback = false;
    this.audio.pause();
    this.reportPlayState(false);
  }

  stop(): void {
    this.wantsPlayback = false;
    this.audio.pause();
    this.reportPlayState(false);
    this.priming = false;
    this.audio.removeAttribute('src');
    this.audio.load();
    this.loadedTrackId = undefined;
    this.fallbackUrl = undefined;
    this.fallbackAttempted = false;
    this.releaseObjectUrl();
  }

  seek(seconds: number): void {
    if (Number.isFinite(seconds)) this.audio.currentTime = Math.max(0, Math.min(seconds, this.audio.duration || seconds));
  }

  private releaseObjectUrl(): void {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
  }

  private async handleError(): Promise<void> {
    if (this.priming) return;
    if (this.fallbackUrl && !this.fallbackAttempted) {
      const resumeAt = this.audio.currentTime || 0;
      const shouldResume = this.wantsPlayback;
      this.fallbackAttempted = true;
      this.setCorsMode(true);
      this.audio.src = this.fallbackUrl;
      this.audio.load();
      if (resumeAt > 0) {
        this.audio.addEventListener('loadedmetadata', () => this.seek(resumeAt), { once: true });
      }
      if (shouldResume) await this.play();
      return;
    }
    this.events.onError('This track could not be played.');
  }

  private setCorsMode(enabled: boolean): void {
    if (enabled) this.audio.crossOrigin = 'anonymous';
    else this.audio.removeAttribute('crossorigin');
  }

  private reportPlayState(playing: boolean): void {
    if (this.reportedPlaying === playing) return;
    this.reportedPlaying = playing;
    this.events.onPlayState(playing);
  }
}

function createSilentWavUrl(): string {
  const sampleCount = 80;
  const bytes = new Uint8Array(44 + sampleCount);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, 'RIFF');
  view.setUint32(4, 36 + sampleCount, true);
  writeAscii(bytes, 8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true);
  view.setUint32(28, 8_000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeAscii(bytes, 36, 'data');
  view.setUint32(40, sampleCount, true);
  bytes.fill(128, 44);
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) target[offset + index] = value.charCodeAt(index);
}
