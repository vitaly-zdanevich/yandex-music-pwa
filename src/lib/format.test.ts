import { describe, expect, it } from 'vitest';
import { artistNames, formatBytes, formatTime } from './format';

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
});
