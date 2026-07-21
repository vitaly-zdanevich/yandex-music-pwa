import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadMediaBlob } from './media-download';
import type { MediaSource } from './media-resolver';

const source: MediaSource = {
	url: 'https://cdn.example/audio.m4a',
	proxyUrl: 'https://proxy.example/api/media/stream',
	codec: 'aac-mp4',
	bitrate: 320,
	quality: 'lossless',
};

afterEach(() => vi.unstubAllGlobals());

describe('downloadMediaBlob', () => {
	it('returns a complete direct response without contacting the proxy', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(new Blob(['complete']), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		const audio = await downloadMediaBlob(source);

		expect(await audio.text()).toBe('complete');
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledWith(source.url, { signal: undefined, cache: 'no-store' });
	});

	it.each([
		['a CORS failure', () => Promise.reject(new TypeError('Failed to fetch'))],
		['a partial direct response', () => Promise.resolve(new Response(new Blob(['part']), { status: 206 }))],
	])('falls back to the proxy after %s', async (_reason, directResult) => {
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(directResult)
			.mockResolvedValueOnce(new Response(new Blob(['complete-from-proxy']), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(downloadMediaBlob(source)).resolves.toSatisfy((audio: Blob) => audio.size === 19);
		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([source.url, source.proxyUrl]);
	});

	it('rejects an empty successful response', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob([]), { status: 200 })));

		await expect(downloadMediaBlob({ ...source, proxyUrl: source.url })).rejects.toThrow(
			'Yandex Music returned an empty audio file.',
		);
	});

	it('rejects a partial response when no distinct proxy fallback exists', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob(['part']), { status: 206 })));

		await expect(downloadMediaBlob({ ...source, proxyUrl: source.url })).rejects.toThrow(
			'The complete audio file could not be downloaded.',
		);
	});
});
