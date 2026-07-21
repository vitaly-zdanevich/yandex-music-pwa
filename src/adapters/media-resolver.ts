import { MusicApiError } from '../sdk';
import { apiUrl } from './api-base';

export interface MediaSource {
	url: string;
	directUrl?: string;
	proxyUrl?: string;
	codec: string;
	bitrate: number;
	size?: number;
	quality: string;
}

export interface MediaResolver {
	resolve(trackId: string): Promise<MediaSource>;
	proxyArtwork(remoteUrl: string): string;
}

export class ProxyMediaResolver implements MediaResolver {
	async resolve(trackId: string): Promise<MediaSource> {
		const response = await fetch(apiUrl(`/api/media/resolve/${encodeURIComponent(trackId)}`), {
			cache: 'no-store',
		});
		const payload = (await response.json().catch(() => ({}))) as Partial<MediaSource> & { error?: string };
		if (!response.ok || !payload.url) {
			throw new MusicApiError(payload.error ?? 'This track is not available for playback.', response.status);
		}
		return {
			url: payload.directUrl ?? payload.url,
			directUrl: payload.directUrl,
			proxyUrl: payload.url,
			codec: payload.codec ?? 'mp3',
			bitrate: payload.bitrate ?? 0,
			size: payload.size,
			quality: payload.quality ?? '',
		};
	}

	proxyArtwork(remoteUrl: string): string {
		const url = apiUrl('/api/media/artwork');
		url.searchParams.set('source', base64UrlEncode(remoteUrl));
		return url.toString();
	}
}

function base64UrlEncode(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
