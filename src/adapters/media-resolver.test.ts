import { afterEach, describe, expect, it, vi } from 'vitest';
import { MusicApiError } from '../sdk';
import { ProxyMediaResolver } from './media-resolver';

afterEach(() => vi.unstubAllGlobals());

describe('ProxyMediaResolver', () => {
	it('preserves the exact file size returned by the proxy', async () => {
		vi.stubGlobal('window', { location: { origin: 'https://app.example' } });
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					url: 'https://proxy.example/audio',
					directUrl: 'https://cdn.example/audio.m4a',
					codec: 'aac-mp4',
					bitrate: 320,
					size: 12_345_678,
					quality: 'lossless',
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(new ProxyMediaResolver().resolve('track/id')).resolves.toEqual({
			url: 'https://cdn.example/audio.m4a',
			directUrl: 'https://cdn.example/audio.m4a',
			proxyUrl: 'https://proxy.example/audio',
			codec: 'aac-mp4',
			bitrate: 320,
			size: 12_345_678,
			quality: 'lossless',
		});
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://app.example/api/media/resolve/track%2Fid');
		expect(fetchMock.mock.calls[0]?.[1]).toEqual({ cache: 'no-store' });
	});

	it('builds a fresh proxy stream URL for cached-track recovery', () => {
		vi.stubGlobal('window', { location: { origin: 'https://app.example' } });

		const url = new URL(new ProxyMediaResolver().proxyStreamUrl('track/id'));

		expect(url.origin).toBe('https://app.example');
		expect(url.pathname).toBe('/api/media/stream');
		expect(url.searchParams.get('track')).toBe('track/id');
	});

	it('raises the proxy error with its HTTP status', async () => {
		vi.stubGlobal('window', { location: { origin: 'https://app.example' } });
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: 'No highest-quality source is available.' }), {
					status: 404,
					headers: { 'Content-Type': 'application/json' },
				}),
			),
		);

		const rejection = new ProxyMediaResolver().resolve('unavailable');
		await expect(rejection).rejects.toBeInstanceOf(MusicApiError);
		await expect(rejection).rejects.toMatchObject({
			message: 'No highest-quality source is available.',
			status: 404,
		});
	});

	it('retains the parser failure from an unreadable proxy response', async () => {
		vi.stubGlobal('window', { location: { origin: 'https://app.example' } });
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
			new Response('<html>failed</html>', { status: 502 }),
		));

		const error = await new ProxyMediaResolver().resolve('broken').catch((failure: unknown) => failure);

		expect(error).toMatchObject({
			message: 'The media proxy returned an unreadable response.',
			status: 502,
		});
		expect((error as MusicApiError).cause).toBeInstanceOf(SyntaxError);
	});
});
