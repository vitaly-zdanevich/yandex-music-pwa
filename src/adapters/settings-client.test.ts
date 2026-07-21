import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsClient } from './settings-client';

describe('SettingsClient', () => {
	afterEach(() => vi.unstubAllGlobals());

	it.each([
		[{ configured: true }, true],
		[{ configured: false }, false],
	] as const)('reads configuration status without sending credentials', async (payload, expected) => {
		vi.stubGlobal('window', { location: { origin: 'https://app.example' } });
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, _options?: RequestInit) =>
			new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(new SettingsClient().status()).resolves.toBe(expected);

		const [requestUrl, options] = fetchMock.mock.calls[0]!;
		expect(String(requestUrl)).toBe('https://app.example/api/settings/status');
		expect(options?.cache).toBe('no-store');
		expect(options?.body).toBeUndefined();
		expect(options?.headers).toBeUndefined();
	});
});
