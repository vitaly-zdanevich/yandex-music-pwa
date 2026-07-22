import type { WikidataTransport } from '../sdk';

export class WikidataApiError extends Error {
	declare readonly cause?: unknown;

	constructor(message: string, readonly status?: number, cause?: unknown) {
		super(message);
		this.name = 'WikidataApiError';
		if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause });
	}
}

export class HttpWikidataTransport implements WikidataTransport {
	async request(url: string, signal?: AbortSignal): Promise<unknown> {
		let response: Response;
		try {
			response = await fetch(url, {
				headers: { Accept: 'application/json' },
				credentials: 'omit',
				referrerPolicy: 'no-referrer',
				signal,
			});
		} catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') throw error;
			throw new WikidataApiError('Could not reach Wikidata.', undefined, error);
		}
		if (!response.ok) {
			throw new WikidataApiError(`Wikidata request failed (${response.status} ${response.statusText}).`, response.status);
		}
		try {
			return await response.json();
		} catch (error) {
			throw new WikidataApiError('Wikidata returned an unreadable response.', response.status, error);
		}
	}
}
