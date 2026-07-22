import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_KEEP_OFFLINE_TRACKS,
	DEFAULT_OFFLINE_TRACK_COUNT,
	loadKeepOfflineTracks,
	loadOfflineTrackCount,
	MAX_OFFLINE_TRACK_COUNT,
	normalizeOfflineTrackCount,
	saveKeepOfflineTracks,
	saveOfflineTrackCount,
} from './offline-preferences';

class MemoryStorage implements Storage {
	readonly values = new Map<string, string>();

	get length(): number {
		return this.values.size;
	}

	clear(): void {
		this.values.clear();
	}

	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	key(index: number): string | null {
		return [...this.values.keys()][index] ?? null;
	}

	removeItem(key: string): void {
		this.values.delete(key);
	}

	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('offline track count preferences', () => {
	it('normalizes numeric user input to the supported integer range', () => {
		expect(normalizeOfflineTrackCount(0)).toBe(0);
		expect(normalizeOfflineTrackCount('17')).toBe(17);
		expect(normalizeOfflineTrackCount(12.9)).toBe(12);
		expect(normalizeOfflineTrackCount(-4)).toBe(0);
		expect(normalizeOfflineTrackCount(500)).toBe(MAX_OFFLINE_TRACK_COUNT);
	});

	it.each([undefined, null, '', 'not a number', Number.NaN, Number.POSITIVE_INFINITY])(
		'uses the default for invalid input %s',
		(value) => {
			expect(normalizeOfflineTrackCount(value)).toBe(DEFAULT_OFFLINE_TRACK_COUNT);
		},
	);

	it('saves and loads a repository-specific local storage value', () => {
		const storage = new MemoryStorage();
		vi.stubGlobal('localStorage', storage);

		expect(saveOfflineTrackCount('24')).toBe(24);
		expect(loadOfflineTrackCount()).toBe(24);
		expect(storage.length).toBe(1);
		expect(storage.key(0)).toContain('yandex-music-pwa');
	});

	it('persists zero to disable automatic offline caching', () => {
		const storage = new MemoryStorage();
		vi.stubGlobal('localStorage', storage);

		saveOfflineTrackCount(0);
		expect(loadOfflineTrackCount()).toBe(0);
	});

	it.each(['', 'nope', '-1', '51', '1.5'])('uses the default for corrupt stored value %s', (value) => {
		const storage = new MemoryStorage();
		storage.setItem('yandex-music-pwa:offline-track-count:v1', value);
		vi.stubGlobal('localStorage', storage);

		expect(loadOfflineTrackCount()).toBe(DEFAULT_OFFLINE_TRACK_COUNT);
	});

	it('falls back safely when local storage is unavailable', () => {
		vi.stubGlobal('localStorage', {
			getItem: () => {
				throw new DOMException('Storage unavailable');
			},
			setItem: () => {
				throw new DOMException('Storage unavailable');
			},
		});

		expect(loadOfflineTrackCount()).toBe(DEFAULT_OFFLINE_TRACK_COUNT);
		expect(saveOfflineTrackCount(8)).toBe(8);
	});
});

describe('offline track retention preference', () => {
	it('is disabled by default', () => {
		const storage = new MemoryStorage();
		vi.stubGlobal('localStorage', storage);

		expect(loadKeepOfflineTracks()).toBe(DEFAULT_KEEP_OFFLINE_TRACKS);
		expect(loadKeepOfflineTracks()).toBe(false);
	});

	it('persists the enabled and disabled states', () => {
		const storage = new MemoryStorage();
		vi.stubGlobal('localStorage', storage);

		expect(saveKeepOfflineTracks(true)).toBe(true);
		expect(loadKeepOfflineTracks()).toBe(true);
		expect(saveKeepOfflineTracks(false)).toBe(false);
		expect(loadKeepOfflineTracks()).toBe(false);
	});

	it('treats corrupt stored values as disabled', () => {
		const storage = new MemoryStorage();
		storage.setItem('yandex-music-pwa:keep-offline-tracks:v1', 'yes');
		vi.stubGlobal('localStorage', storage);

		expect(loadKeepOfflineTracks()).toBe(false);
	});

	it('falls back safely when local storage is unavailable', () => {
		vi.stubGlobal('localStorage', {
			getItem: () => {
				throw new DOMException('Storage unavailable');
			},
			setItem: () => {
				throw new DOMException('Storage unavailable');
			},
		});

		expect(loadKeepOfflineTracks()).toBe(false);
		expect(saveKeepOfflineTracks(true)).toBe(true);
	});
});
