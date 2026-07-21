import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../sdk';
import { AudioPlayer } from './audio-player';

class FakeAudio extends EventTarget {
  preload = '';
  paused = true;
  currentTime = 0;
  duration = 180;
  src = '';
  crossOrigin: string | null = null;
  readonly load = vi.fn();
  readonly play = vi.fn(async () => {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
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
});
