import { describe, expect, it } from 'vitest';
import { artistNames, formatBytes, formatMediaQuality, formatTime } from './format';

describe('format helpers', () => {
	it('formats byte and time values', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(1_572_864)).toBe('1.5 MB');
		expect(formatTime(125.9)).toBe('2:05');
	});

	it('joins artist names and provides a fallback', () => {
		expect(artistNames({ artists: [{ name: 'A' }, { name: 'B' }] })).toBe('A, B');
		expect(artistNames({ artists: [] })).toBe('Unknown artist');
	});

	it('shows quality, codec, bitrate, and exact file size', () => {
		expect(
			formatMediaQuality({ quality: 'lossless', codec: 'aac-mp4', bitrate: 256, size: 8_650_752 }, 270_000),
		).toBe('Lossless · AAC-MP4 · 256 kbps · 8.3 MB');
	});

	it('derives missing bitrate and estimates a missing size', () => {
		expect(formatMediaQuality({ quality: 'lossless', codec: 'flac', size: 31_744_000 }, 180_000)).toBe(
			'Lossless · FLAC · 1411 kbps · 30 MB',
		);
		expect(formatMediaQuality({ quality: 'high', codec: 'mp3', bitrate: 320 }, 180_000)).toBe(
			'Highest available · MP3 · 320 kbps · ≈6.9 MB',
		);
	});
});
