import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../sdk';
import { AudioPlayer } from './audio-player';

class FakeAudio extends EventTarget {
	preload = '';
	controls = true;
	paused = true;
	currentTime = 0;
	duration = 180;
	src = '';
	crossOrigin: string | null = null;
	readonly load = vi.fn();
	readonly play = vi.fn(async () => {
		this.paused = false;
		this.dispatchEvent(new Event('playing'));
	});
	readonly pause = vi.fn(() => {
		const changed = !this.paused;
		this.paused = true;
		if (changed) this.dispatchEvent(new Event('pause'));
	});

	setAttribute(name: string, value: string): void {
		if (name === 'crossorigin') this.crossOrigin = value;
	}

	removeAttribute(name: string): void {
		if (name === 'src') this.src = '';
		if (name === 'crossorigin') this.crossOrigin = null;
	}
}

const instances: FakeAudio[] = [];
const track: Track = {
	id: '1',
	title: 'Track',
	artists: [],
	durationMs: 180_000,
	liked: false,
	disliked: false,
};

beforeEach(() => {
	instances.length = 0;
	vi.stubGlobal(
		'Audio',
		class extends FakeAudio {
			constructor() {
				super();
				instances.push(this);
			}
		},
	);
});

afterEach(() => vi.unstubAllGlobals());

describe('AudioPlayer', () => {
	it('mounts one persistent audio instance only once in the same parent', () => {
		const player = new AudioPlayer({
			onEnded: vi.fn(),
			onError: vi.fn(),
			onPlayState: vi.fn(),
			onTime: vi.fn(),
		});
		const parent = { append: vi.fn() } as unknown as HTMLElement;

		player.mount(parent);
		player.mount(parent);

		expect(instances).toHaveLength(1);
		expect(parent.append).toHaveBeenCalledOnce();
		expect(parent.append).toHaveBeenCalledWith(instances[0]);
		expect(instances[0]?.controls).toBe(false);
	});

	it('reports playback from media events instead of the play promise', async () => {
		const onMediaReady = vi.fn();
		const onPlayState = vi.fn();
		const player = new AudioPlayer({
			onEnded: vi.fn(),
			onError: vi.fn(),
			onMediaReady,
			onPlayState,
			onTime: vi.fn(),
		});
		const audio = instances[0]!;
		audio.play.mockResolvedValueOnce(undefined);
		player.load(track, 'https://cdn.yandex.net/track.flac');

		await player.play();
		expect(onPlayState).not.toHaveBeenCalled();

		audio.paused = false;
		audio.dispatchEvent(new Event('playing'));
		expect(onPlayState).toHaveBeenLastCalledWith(true);
		expect(onMediaReady).toHaveBeenCalledOnce();

		audio.paused = true;
		audio.dispatchEvent(new Event('pause'));
		expect(onPlayState).toHaveBeenLastCalledWith(false);

		audio.dispatchEvent(new Event('loadedmetadata'));
		expect(onMediaReady).toHaveBeenCalledTimes(2);
	});

	it('retries an aborted play once on canplay without showing a false error', async () => {
		const onError = vi.fn();
		const onPlayState = vi.fn();
		const player = new AudioPlayer({
			onEnded: vi.fn(),
			onError,
			onPlayState,
			onTime: vi.fn(),
		});
		const audio = instances[0]!;
		audio.play.mockRejectedValueOnce(new DOMException('Source changed', 'AbortError'));
		player.load(track, 'https://cdn.yandex.net/track.flac');

		await player.play();

		expect(audio.play).toHaveBeenCalledOnce();
		expect(onError).not.toHaveBeenCalled();
		expect(onPlayState).not.toHaveBeenCalled();

		audio.dispatchEvent(new Event('canplay'));

		await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(2));
		expect(onError).not.toHaveBeenCalled();
		expect(onPlayState).toHaveBeenLastCalledWith(true);
	});

	it('does not retry an aborted play after playback is paused', async () => {
		const player = new AudioPlayer({
			onEnded: vi.fn(),
			onError: vi.fn(),
			onPlayState: vi.fn(),
			onTime: vi.fn(),
		});
		const audio = instances[0]!;
		audio.play.mockRejectedValueOnce(new DOMException('Source changed', 'AbortError'));
		player.load(track, 'https://cdn.yandex.net/track.flac');

		await player.play();
		player.pause();
		audio.dispatchEvent(new Event('canplay'));

		expect(audio.play).toHaveBeenCalledOnce();
	});

	it('switches a failed direct CDN source to the CORS-enabled Lambda fallback', async () => {
		const onError = vi.fn();
		const player = new AudioPlayer({
			onEnded: vi.fn(),
			onError,
			onPlayState: vi.fn(),
			onTime: vi.fn(),
		});
		const audio = instances[0]!;
		player.load(track, 'https://cdn.yandex.net/track.flac', false, 'https://lambda.example/api/media/stream');
		await player.play();

		audio.dispatchEvent(new Event('error'));

		await vi.waitFor(() => expect(audio.src).toBe('https://lambda.example/api/media/stream'));
		expect(audio.crossOrigin).toBe('anonymous');
		expect(audio.play).toHaveBeenCalledTimes(2);
		expect(onError).not.toHaveBeenCalled();
	});

	it('primes synchronously without reporting playback or advancing the queue', () => {
		const onEnded = vi.fn();
		const onPlayState = vi.fn();
		const player = new AudioPlayer({
			onEnded,
			onError: vi.fn(),
			onPlayState,
			onTime: vi.fn(),
		});
		const audio = instances[0]!;

		player.primeForUserGesture();

		expect(audio.play).toHaveBeenCalledOnce();
		expect(audio.load).toHaveBeenCalledOnce();
		expect(onPlayState).not.toHaveBeenCalled();

		audio.dispatchEvent(new Event('ended'));

		expect(onEnded).not.toHaveBeenCalled();

		player.load(track, 'https://cdn.yandex.net/track.flac');
		expect(onPlayState).not.toHaveBeenCalled();
	});

	it('replaces an old track with the silent prime instead of replaying it', () => {
		const player = new AudioPlayer({
			onEnded: vi.fn(),
			onError: vi.fn(),
			onPlayState: vi.fn(),
			onTime: vi.fn(),
		});
		const audio = instances[0]!;
		player.load(track, 'https://cdn.yandex.net/old-track.flac');

		player.primeForUserGesture();

		expect(audio.src).toMatch(/^blob:/);
		expect(audio.src).not.toContain('old-track');
		expect(audio.load).toHaveBeenCalledTimes(2);
	});

	it('clears a previously playing state after a terminal media failure', async () => {
		const onError = vi.fn();
		const onPlayState = vi.fn();
		const player = new AudioPlayer({
			onEnded: vi.fn(),
			onError,
			onPlayState,
			onTime: vi.fn(),
		});
		const audio = instances[0]!;
		player.load(track, 'https://cdn.yandex.net/track.flac');
		await player.play();

		audio.dispatchEvent(new Event('error'));

		await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('This track could not be played.'));
		expect(onPlayState).toHaveBeenLastCalledWith(false);
	});
});
