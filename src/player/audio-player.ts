import type { Track } from '../sdk';

export interface PlayerEvents {
	onEnded: () => void;
	onError: (message: string) => void;
	onMediaReady?: () => void;
	onPlayState: (playing: boolean) => void;
	onRecoveryState?: (recovering: boolean) => void;
	onTime: (currentSeconds: number, durationSeconds: number) => void;
}

export class AudioPlayer {
	private static readonly mediaRetryDelaysMs = [500, 1_500, 3_000] as const;
	private readonly audio = new Audio();
	private readonly silentSource = createSilentWavUrl();
	private objectUrl?: string;
	private loadedTrackId?: string;
	private fallbackUrl?: string;
	private fallbackAttempted = false;
	private activeProxyUrl?: string;
	private mediaRetryAttempt = 0;
	private pendingMediaRetry?: ReturnType<typeof setTimeout>;
	private lastPlaybackTime = 0;
	private terminalMediaError = false;
	private recovering = false;
	private wantsPlayback = false;
	private priming = false;
	private reportedPlaying = false;
	private mountedIn?: HTMLElement;
	private sourceRevision = 0;
	private pendingAbortRetry?: EventListener;
	private pendingPositionRestore?: EventListener;

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
				this.terminalMediaError = false;
				this.cancelMediaRetry();
				this.setRecoveryState(false);
				this.reportPlayState(true);
				events.onMediaReady?.();
			}
		});
		this.audio.addEventListener('loadedmetadata', () => {
			if (!this.priming && this.loadedTrackId) events.onMediaReady?.();
		});
		this.audio.addEventListener('timeupdate', () => {
			const current = this.audio.currentTime || 0;
			if (current > this.lastPlaybackTime) this.lastPlaybackTime = current;
			events.onTime(current, Number.isFinite(this.audio.duration) ? this.audio.duration : 0);
		});
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
		this.cancelMediaRetry();
		this.clearPositionRestore();
		this.setRecoveryState(false);
		this.sourceRevision += 1;
		this.wantsPlayback = false;
		this.priming = true;
		this.activeProxyUrl = undefined;
		this.mediaRetryAttempt = 0;
		this.lastPlaybackTime = 0;
		this.terminalMediaError = false;
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
		this.cancelMediaRetry();
		this.clearPositionRestore();
		this.setRecoveryState(false);
		this.sourceRevision += 1;
		this.audio.pause();
		this.priming = false;
		const previousObjectUrl = this.objectUrl;
		this.loadedTrackId = track.id;
		this.fallbackUrl = fallbackUrl;
		this.fallbackAttempted = false;
		this.activeProxyUrl = useCors ? source : undefined;
		this.mediaRetryAttempt = 0;
		this.lastPlaybackTime = 0;
		this.terminalMediaError = false;
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
		if (this.pendingMediaRetry !== undefined) return;
		if (this.terminalMediaError && this.activeProxyUrl) {
			const resumeAt = this.resumePosition();
			this.mediaRetryAttempt = 0;
			this.clearPositionRestore();
			this.setRecoveryState(true);
			this.sourceRevision += 1;
			this.setCorsMode(true);
			this.audio.src = this.activeProxyUrl;
			this.audio.load();
			this.restorePosition(resumeAt, this.sourceRevision);
		}
		this.terminalMediaError = false;
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
			if (!(error instanceof DOMException && error.name === 'NotAllowedError') && this.scheduleMediaRetry()) return;
			const message = error instanceof DOMException && error.name === 'NotAllowedError'
				? 'Tap play again to allow audio on this device.'
				: 'Playback could not start.';
			this.reportTerminalError(message);
		}
	}

	pause(): void {
		this.wantsPlayback = false;
		this.cancelAbortRetry();
		this.cancelMediaRetry();
		this.setRecoveryState(false);
		this.audio.pause();
	}

	stop(): void {
		this.wantsPlayback = false;
		this.cancelAbortRetry();
		this.cancelMediaRetry();
		this.clearPositionRestore();
		this.setRecoveryState(false);
		this.sourceRevision += 1;
		this.audio.pause();
		this.priming = false;
		this.audio.removeAttribute('src');
		this.audio.load();
		this.loadedTrackId = undefined;
		this.fallbackUrl = undefined;
		this.fallbackAttempted = false;
		this.activeProxyUrl = undefined;
		this.mediaRetryAttempt = 0;
		this.lastPlaybackTime = 0;
		this.terminalMediaError = false;
		this.releaseObjectUrl();
	}

	seek(seconds: number): void {
		if (!Number.isFinite(seconds)) return;
		const target = Math.max(0, Math.min(seconds, this.audio.duration || seconds));
		this.audio.currentTime = target;
		this.lastPlaybackTime = target;
	}

	private releaseObjectUrl(): void {
		if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
		this.objectUrl = undefined;
	}

	private async handleError(): Promise<void> {
		if (this.priming || this.terminalMediaError) return;
		if (this.fallbackUrl && !this.fallbackAttempted) {
			const resumeAt = this.resumePosition();
			const shouldResume = this.wantsPlayback;
			this.fallbackAttempted = true;
			this.cancelAbortRetry();
			this.cancelMediaRetry();
			this.clearPositionRestore();
			this.sourceRevision += 1;
			const revision = this.sourceRevision;
			this.activeProxyUrl = this.fallbackUrl;
			this.setCorsMode(true);
			this.audio.src = this.fallbackUrl;
			this.audio.load();
			this.restorePosition(resumeAt, revision);
			if (shouldResume) await this.play();
			return;
		}
		if (this.scheduleMediaRetry()) return;
		this.reportTerminalError('This track could not be played.');
	}

	private scheduleMediaRetry(): boolean {
		if (!this.wantsPlayback || !this.activeProxyUrl) return false;
		if (this.pendingMediaRetry !== undefined) return true;
		const delay = AudioPlayer.mediaRetryDelaysMs[this.mediaRetryAttempt];
		if (delay === undefined) return false;
		const resumeAt = this.resumePosition();
		const revision = this.sourceRevision;
		const proxyUrl = this.activeProxyUrl;
		this.cancelAbortRetry();
		this.setRecoveryState(true);
		this.reportPlayState(false);
		this.pendingMediaRetry = globalThis.setTimeout(() => {
			this.pendingMediaRetry = undefined;
			if (!this.wantsPlayback || revision !== this.sourceRevision || proxyUrl !== this.activeProxyUrl) return;
			this.mediaRetryAttempt += 1;
			this.clearPositionRestore();
			this.sourceRevision += 1;
			const retryRevision = this.sourceRevision;
			this.setCorsMode(true);
			this.audio.src = proxyUrl;
			this.audio.load();
			this.restorePosition(resumeAt, retryRevision);
			void this.attemptPlayback(1, retryRevision);
		}, delay);
		return true;
	}

	private resumePosition(): number {
		const current = Number.isFinite(this.audio.currentTime) ? Math.max(0, this.audio.currentTime) : 0;
		return Math.max(current, this.lastPlaybackTime);
	}

	private restorePosition(seconds: number, sourceRevision: number): void {
		if (seconds <= 0) return;
		const restore: EventListener = () => {
			if (this.pendingPositionRestore === restore) this.pendingPositionRestore = undefined;
			if (sourceRevision === this.sourceRevision && this.loadedTrackId) this.seek(seconds);
		};
		this.pendingPositionRestore = restore;
		this.audio.addEventListener('loadedmetadata', restore, { once: true });
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

	private cancelMediaRetry(): void {
		if (this.pendingMediaRetry === undefined) return;
		globalThis.clearTimeout(this.pendingMediaRetry);
		this.pendingMediaRetry = undefined;
	}

	private clearPositionRestore(): void {
		if (!this.pendingPositionRestore) return;
		this.audio.removeEventListener('loadedmetadata', this.pendingPositionRestore);
		this.pendingPositionRestore = undefined;
	}

	private reportTerminalError(message: string): void {
		this.wantsPlayback = false;
		this.setRecoveryState(false);
		this.reportPlayState(false);
		if (this.terminalMediaError) return;
		this.terminalMediaError = true;
		this.events.onError(message);
	}

	private setRecoveryState(recovering: boolean): void {
		if (this.recovering === recovering) return;
		this.recovering = recovering;
		this.events.onRecoveryState?.(recovering);
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
