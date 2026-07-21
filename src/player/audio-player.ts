import type { Track } from '../sdk';

export interface PlayerEvents {
	onEnded: () => void;
	onError: (message: string) => void;
	onMediaReady?: () => void;
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
	private mountedIn?: HTMLElement;
	private sourceRevision = 0;
	private pendingAbortRetry?: EventListener;

	constructor(private readonly events: PlayerEvents) {
		this.audio.preload = 'auto';
		this.audio.controls = false;
		this.audio.setAttribute('playsinline', '');
		this.audio.setAttribute('aria-hidden', 'true');
		this.audio.addEventListener('ended', () => {
			if (!this.priming && this.loadedTrackId) {
				this.wantsPlayback = false;
				this.reportPlayState(false);
				events.onEnded();
			}
		});
		this.audio.addEventListener('pause', () => {
			if (!this.priming && this.audio.paused) this.reportPlayState(false);
		});
		this.audio.addEventListener('playing', () => {
			if (!this.priming && this.loadedTrackId) {
				this.reportPlayState(true);
				events.onMediaReady?.();
			}
		});
		this.audio.addEventListener('loadedmetadata', () => {
			if (!this.priming && this.loadedTrackId) events.onMediaReady?.();
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

	/** Keep the sole media element connected so iOS can retain its Now Playing session. */
	mount(parent: HTMLElement): void {
		if (this.mountedIn === parent) return;
		parent.append(this.audio);
		this.mountedIn = parent;
	}

	/** Invoke synchronously from a tap before an IndexedDB/network await on iOS. */
	primeForUserGesture(): void {
		this.cancelAbortRetry();
		this.sourceRevision += 1;
		this.wantsPlayback = false;
		this.priming = true;
		this.setCorsMode(false);
		const previousObjectUrl = this.objectUrl;
		this.objectUrl = undefined;
		this.audio.src = this.silentSource;
		this.audio.load();
		if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);
		void this.audio.play().catch(() => {
			// The real play attempt reports a useful message after preparation.
		});
	}

	load(track: Track, source: string, isObjectUrl = false, fallbackUrl?: string, useCors = false): void {
		this.cancelAbortRetry();
		this.sourceRevision += 1;
		this.audio.pause();
		this.priming = false;
		const previousObjectUrl = this.objectUrl;
		this.loadedTrackId = track.id;
		this.fallbackUrl = fallbackUrl;
		this.fallbackAttempted = false;
		this.wantsPlayback = false;
		this.setCorsMode(useCors);
		this.audio.src = source;
		this.objectUrl = isObjectUrl ? source : undefined;
		this.audio.load();
		if (previousObjectUrl && previousObjectUrl !== source) URL.revokeObjectURL(previousObjectUrl);
	}

	async play(): Promise<void> {
		if (!this.loadedTrackId) {
			this.stop();
			this.events.onError('The track is not ready yet.');
			return;
		}
		this.cancelAbortRetry();
		this.wantsPlayback = true;
		await this.attemptPlayback(1, this.sourceRevision);
	}

	private async attemptPlayback(abortRetriesRemaining: number, sourceRevision: number): Promise<void> {
		try {
			await this.audio.play();
		} catch (error) {
			if (!this.wantsPlayback || sourceRevision !== this.sourceRevision) return;
			if (error instanceof DOMException && error.name === 'AbortError' && abortRetriesRemaining > 0) {
				this.retryOnCanPlay(sourceRevision);
				return;
			}
			const message = error instanceof DOMException && error.name === 'NotAllowedError'
				? 'Tap play again to allow audio on this device.'
				: 'Playback could not start.';
			this.wantsPlayback = false;
			this.reportPlayState(false);
			this.events.onError(message);
		}
	}

	pause(): void {
		this.wantsPlayback = false;
		this.cancelAbortRetry();
		this.audio.pause();
	}

	stop(): void {
		this.wantsPlayback = false;
		this.cancelAbortRetry();
		this.sourceRevision += 1;
		this.audio.pause();
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
			this.cancelAbortRetry();
			this.sourceRevision += 1;
			this.setCorsMode(true);
			this.audio.src = this.fallbackUrl;
			this.audio.load();
			if (resumeAt > 0) {
				this.audio.addEventListener('loadedmetadata', () => this.seek(resumeAt), { once: true });
			}
			if (shouldResume) await this.play();
			return;
		}
		this.wantsPlayback = false;
		this.reportPlayState(false);
		this.events.onError('This track could not be played.');
	}

	private setCorsMode(enabled: boolean): void {
		if (enabled) this.audio.crossOrigin = 'anonymous';
		else this.audio.removeAttribute('crossorigin');
	}

	private retryOnCanPlay(sourceRevision: number): void {
		const retry: EventListener = () => {
			this.pendingAbortRetry = undefined;
			if (!this.wantsPlayback || sourceRevision !== this.sourceRevision) return;
			void this.attemptPlayback(0, sourceRevision);
		};
		this.pendingAbortRetry = retry;
		this.audio.addEventListener('canplay', retry, { once: true });
	}

	private cancelAbortRetry(): void {
		if (!this.pendingAbortRetry) return;
		this.audio.removeEventListener('canplay', this.pendingAbortRetry);
		this.pendingAbortRetry = undefined;
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
