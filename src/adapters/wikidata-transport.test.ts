import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpWikidataTransport, WikidataApiError } from './wikidata-transport';

afterEach(() => vi.unstubAllGlobals());

describe('HttpWikidataTransport', () => {
	it('loads public JSON without credentials or referrer data', async () => {
		const payload = { query: { search: [{ title: 'Q105978624' }] } };
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(payload), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(new HttpWikidataTransport().request('https://www.wikidata.org/w/api.php')).resolves.toEqual(payload);
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
	});

	it('preserves complete HTTP and network failure details', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503, statusText: 'Busy' })));
		await expect(new HttpWikidataTransport().request('https://www.wikidata.org/w/api.php')).rejects.toMatchObject({
			name: 'WikidataApiError',
			status: 503,
		});

		const cause = new TypeError('Network unavailable');
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause));
		const error = await new HttpWikidataTransport()
			.request('https://www.wikidata.org/w/api.php')
			.catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(WikidataApiError);
		expect(error).toMatchObject({ cause });
	});
});
