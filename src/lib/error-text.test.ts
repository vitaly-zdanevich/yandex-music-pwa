import { describe, expect, it } from 'vitest';
import { formatErrorText } from './error-text';

describe('formatErrorText', () => {
	it('keeps strings unchanged and names nullish values explicitly', () => {
		expect(formatErrorText('Network request failed\nTry again')).toBe('Network request failed\nTry again');
		expect(formatErrorText(null)).toBe('null');
		expect(formatErrorText(undefined)).toBe('undefined');
	});

	it('preserves the stack and includes diagnostic fields and nested causes', () => {
		const cause = new Error('socket closed');
		cause.name = 'NetworkError';
		cause.stack = 'NetworkError: socket closed\n\tat fetchTrack (network.ts:10:2)';
		Object.assign(cause, { code: 'ECONNRESET' });

		const error = new Error('could not reach Yandex Music');
		error.stack = 'MusicApiError: could not reach Yandex Music\n\tat likeTrack (client.ts:20:3)';
		Object.assign(error, { status: 502, code: 'UPSTREAM_FAILURE' });
		Object.defineProperty(error, 'cause', { configurable: true, value: cause });

		const text = formatErrorText(error);
		expect(text).toContain(error.stack);
		expect(text).toContain('status: 502');
		expect(text).toContain('code: "UPSTREAM_FAILURE"');
		expect(text).toContain('Caused by:\n\tNetworkError: socket closed');
		expect(text).toContain('\tcode: "ECONNRESET"');
		expect(text.match(/MusicApiError: could not reach Yandex Music/g)).toHaveLength(1);
	});

	it('uses the error name and message when no stack is available', () => {
		const error = new Error('offline');
		error.name = 'PlaybackError';
		Object.defineProperty(error, 'stack', { configurable: true, value: undefined });
		expect(formatErrorText(error)).toBe('PlaybackError: offline');
	});

	it('removes a redundant bundle location from the first Safari stack line', () => {
		const error = new TypeError('Load failed');
		error.stack = [
			'TypeError: Load failed@https://example.test/assets/index-AbCd.js:1:4843',
			'promiseReactionJob@[native code]',
		].join('\n');
		Object.assign(error, {
			sourceURL: 'https://example.test/assets/index-AbCd.js',
			line: 1,
			column: 4843,
		});

		const text = formatErrorText(error);
		expect(text.split('\n')[0]).toBe('TypeError: Load failed');
		expect(text).toContain('promiseReactionJob@[native code]');
		expect(text).toContain('sourceURL: "https://example.test/assets/index-AbCd.js"');
		expect(text).toContain('line: 1');
		expect(text).toContain('column: 4843');
	});

	it('renders arbitrary and circular data without invoking getters', () => {
		const details: Record<string, unknown> = {
			attempt: 3,
			missing: undefined,
			requestId: 42n,
		};
		Object.defineProperty(details, 'response', {
			enumerable: true,
			get: () => {
				throw new Error('must not run');
			},
		});
		details.self = details;

		expect(formatErrorText(details)).toBe([
			'{',
			'\t"attempt": 3,',
			'\t"missing": undefined,',
			'\t"requestId": 42n,',
			'\t"response": "[Getter]",',
			'\t"self": [Circular]',
			'}',
		].join('\n'));
	});

	it('handles circular causes and hostile objects without throwing', () => {
		const error = new Error('loop');
		Object.defineProperty(error, 'cause', { configurable: true, value: error });
		expect(formatErrorText(error)).toContain('Caused by:\n\t[Circular Error]');

		const hostile = new Proxy({}, {
			getOwnPropertyDescriptor: () => {
				throw new Error('blocked');
			},
			getPrototypeOf: () => {
				throw new Error('blocked');
			},
			ownKeys: () => {
				throw new Error('blocked');
			},
		});
		expect(() => formatErrorText(hostile)).not.toThrow();
		expect(formatErrorText(hostile)).toBe('[Unserializable object]');
	});
});
