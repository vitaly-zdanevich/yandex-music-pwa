import { MusicApiError, type MusicRequest, type MusicTransport } from '../sdk';
import { apiUrl } from './api-base';

interface ApiEnvelope<T> {
	result?: T;
	error?: string | { message?: string };
	errorDescription?: string;
}

const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_MS = [250, 750, 1_500, 3_000] as const;

export class HttpMusicTransport implements MusicTransport {
	async request<T>(request: MusicRequest): Promise<T> {
		const url = apiUrl(`/api/yandex${request.path}`);
		for (const [key, value] of Object.entries(request.query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
		const headers = new Headers({ Accept: 'application/json' });
		let body: string | undefined;
		if (request.body?.kind === 'json') {
			headers.set('Content-Type', 'application/json');
			body = JSON.stringify(request.body.value);
		} else if (request.body?.kind === 'form') {
			headers.set('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
			const form = new URLSearchParams();
			for (const [key, rawValue] of Object.entries(request.body.value)) {
				for (const value of Array.isArray(rawValue) ? rawValue : [rawValue]) form.append(key, value);
			}
			body = form.toString();
		}

		let response: Response | undefined;
		for (let attempt = 0; attempt <= (request.retry === 'transient' ? RETRY_DELAYS_MS.length : 0); attempt += 1) {
			try {
				response = await fetch(url, { method: request.method ?? 'GET', headers, body, cache: 'no-store' });
			} catch {
				if (request.retry === 'transient' && attempt < RETRY_DELAYS_MS.length) {
					await wait(RETRY_DELAYS_MS[attempt]!);
					continue;
				}
				throw new MusicApiError('Could not reach Yandex Music. Check your connection or try again in a moment.');
			}
			if (request.retry !== 'transient' || !TRANSIENT_STATUSES.has(response.status) || attempt === RETRY_DELAYS_MS.length) {
				break;
			}
			await wait(retryDelay(response, RETRY_DELAYS_MS[attempt]!));
		}
		if (!response) throw new MusicApiError('Could not reach Yandex Music. Try again in a moment.');

		let payload: ApiEnvelope<T>;
		try {
			payload = (await response.json()) as ApiEnvelope<T>;
		} catch {
			throw new MusicApiError('Yandex Music returned an unreadable response.', response.status);
		}
		if (!response.ok || payload.result === undefined) {
			const apiMessage = typeof payload.error === 'string' ? payload.error : payload.error?.message;
			const message =
				response.status === 401 || response.status === 403
					? 'The token is invalid or has no Yandex Music access.'
					: TRANSIENT_STATUSES.has(response.status)
						? 'Yandex Music proxy is busy. Try again in a moment.'
					: apiMessage ?? payload.errorDescription ?? `Yandex Music request failed (${response.status}).`;
			throw new MusicApiError(message, response.status);
		}
		return payload.result;
	}
}

function retryDelay(response: Response, fallbackMs: number): number {
	const value = response.headers.get('Retry-After');
	if (!value) return fallbackMs;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 5_000);
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? Math.min(Math.max(0, timestamp - Date.now()), 5_000) : fallbackMs;
}

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
