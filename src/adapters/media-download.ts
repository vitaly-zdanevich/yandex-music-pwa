import type { MediaSource } from './media-resolver';

/** Downloads a complete file, falling back to Lambda when the CDN blocks CORS. */
export async function downloadMediaBlob(source: MediaSource, signal?: AbortSignal): Promise<Blob> {
	let response: Response;
	try {
		response = await fetch(source.url, { signal, cache: 'no-store' });
		if ((!response.ok || response.status === 206) && source.proxyUrl && source.proxyUrl !== source.url) {
			response = await fetch(source.proxyUrl, { signal, cache: 'no-store' });
		}
	} catch (error) {
		if (!source.proxyUrl || source.proxyUrl === source.url) throw error;
		response = await fetch(source.proxyUrl, { signal, cache: 'no-store' });
	}
	if (!response.ok || response.status === 206) {
		throw new Error('The complete audio file could not be downloaded.');
	}
	const audio = await response.blob();
	if (!audio.size) throw new Error('Yandex Music returned an empty audio file.');
	return audio;
}
