export const DEFAULT_OFFLINE_TRACK_COUNT = 10;
export const MAX_OFFLINE_TRACK_COUNT = 50;
export const DEFAULT_KEEP_OFFLINE_TRACKS = false;

const TRACK_COUNT_STORAGE_KEY = 'yandex-music-pwa:offline-track-count:v1';
const KEEP_TRACKS_STORAGE_KEY = 'yandex-music-pwa:keep-offline-tracks:v1';

function localStorageOrNull(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

function numericValue(value: unknown): number | null {
	if (typeof value === 'string' && value.trim() === '') return null;
	if (typeof value !== 'number' && typeof value !== 'string') return null;

	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeOfflineTrackCount(value: unknown): number {
	const parsed = numericValue(value);
	if (parsed === null) return DEFAULT_OFFLINE_TRACK_COUNT;
	return Math.min(MAX_OFFLINE_TRACK_COUNT, Math.max(0, Math.trunc(parsed)));
}

export function loadOfflineTrackCount(): number {
	const storage = localStorageOrNull();
	if (!storage) return DEFAULT_OFFLINE_TRACK_COUNT;

	try {
		const serialized = storage.getItem(TRACK_COUNT_STORAGE_KEY);
		const parsed = numericValue(serialized);
		if (parsed === null || !Number.isInteger(parsed) || parsed < 0 || parsed > MAX_OFFLINE_TRACK_COUNT) {
			return DEFAULT_OFFLINE_TRACK_COUNT;
		}
		return parsed;
	} catch {
		return DEFAULT_OFFLINE_TRACK_COUNT;
	}
}

export function saveOfflineTrackCount(value: unknown): number {
	const normalized = normalizeOfflineTrackCount(value);
	try {
		localStorageOrNull()?.setItem(TRACK_COUNT_STORAGE_KEY, String(normalized));
	} catch {
		// The in-memory setting remains usable when storage is disabled or full.
	}
	return normalized;
}

export function loadKeepOfflineTracks(): boolean {
	const storage = localStorageOrNull();
	if (!storage) return DEFAULT_KEEP_OFFLINE_TRACKS;

	try {
		return storage.getItem(KEEP_TRACKS_STORAGE_KEY) === 'true';
	} catch {
		return DEFAULT_KEEP_OFFLINE_TRACKS;
	}
}

export function saveKeepOfflineTracks(value: boolean): boolean {
	try {
		localStorageOrNull()?.setItem(KEEP_TRACKS_STORAGE_KEY, String(value));
	} catch {
		// The in-memory setting remains usable when storage is disabled or full.
	}
	return value;
}
