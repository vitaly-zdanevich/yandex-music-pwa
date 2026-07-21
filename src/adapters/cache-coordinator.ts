import type { Track } from '../sdk';
import { downloadMediaBlob } from './media-download';
import type { MediaResolver } from './media-resolver';
import type { OfflineStore } from './offline-store';

export interface CacheProgress {
	pending: number;
	current?: Track;
	completed?: Track;
	error?: string;
}

export class CacheCoordinator {
	private readonly pending = new Map<string, Track>();
	private running = false;
	private generation = 0;
	private controller?: AbortController;

	constructor(
		private readonly store: OfflineStore,
		private readonly media: MediaResolver,
		private readonly onProgress: (progress: CacheProgress) => void,
	) {}

	enqueue(tracks: readonly Track[]): void {
		for (const track of tracks) this.pending.set(track.id, track);
		this.onProgress({ pending: this.pending.size });
		void this.drain();
	}

	replace(tracks: readonly Track[]): void {
		this.generation += 1;
		this.pending.clear();
		this.controller?.abort();
		for (const track of tracks) this.pending.set(track.id, track);
		this.onProgress({ pending: this.pending.size });
		void this.drain();
	}

	cancel(): void {
		this.generation += 1;
		this.pending.clear();
		this.controller?.abort();
		this.onProgress({ pending: 0 });
	}

	private async drain(): Promise<void> {
		if (this.running) return;
		this.running = true;
		const runGeneration = this.generation;
		try {
			while (this.pending.size && runGeneration === this.generation) {
				const next = this.pending.entries().next().value as [string, Track] | undefined;
				if (!next) break;
				const [id, track] = next;
				this.pending.delete(id);
				if (await this.store.has(id)) continue;
				this.onProgress({ pending: this.pending.size + 1, current: track });
				this.controller = new AbortController();
				try {
					await this.cacheTrack(track, this.controller.signal);
					if (runGeneration === this.generation) {
						this.onProgress({ pending: this.pending.size, completed: track });
					} else if (!this.pending.has(id)) {
						await this.store.remove(id);
					}
				} catch (error) {
					if (runGeneration !== this.generation) break;
					const message =
						error instanceof DOMException && error.name === 'QuotaExceededError'
							? 'Storage is full. Remove some offline tracks and try again.'
							: error instanceof Error
								? error.message
								: 'A track could not be cached.';
					this.onProgress({ pending: this.pending.size, error: message });
				}
			}
		} finally {
			this.controller = undefined;
			this.running = false;
			if (this.pending.size && runGeneration !== this.generation) void this.drain();
		}
	}

	private async cacheTrack(track: Track, signal: AbortSignal): Promise<void> {
		const source = await this.media.resolve(track.id);
		const audio = await downloadMediaBlob(source, signal);

		let artwork: Blob | undefined;
		if (track.artworkUrl) {
			try {
				let artworkResponse: Response;
				try {
					artworkResponse = await fetch(track.artworkUrl, { signal, cache: 'no-store' });
					if (!artworkResponse.ok) {
						artworkResponse = await fetch(this.media.proxyArtwork(track.artworkUrl), { signal, cache: 'no-store' });
					}
				} catch {
					artworkResponse = await fetch(this.media.proxyArtwork(track.artworkUrl), { signal, cache: 'no-store' });
				}
				if (artworkResponse.ok) artwork = await artworkResponse.blob();
			} catch (error) {
				if (error instanceof DOMException && error.name === 'AbortError') throw error;
				// Artwork is optional; retain playable audio with a local placeholder.
			}
		}
		if (!signal.aborted) {
			await this.store.put(track, audio, artwork, {
				codec: source.codec,
				bitrate: source.bitrate,
				quality: source.quality,
			});
		}
	}
}
