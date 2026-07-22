import { describe, expect, it, vi } from 'vitest';
import {
	geniusPageUrl,
	lyricsTranslatePageUrl,
	musicBrainzRecordingUrl,
	WikidataClient,
	type WikidataTransport,
	wikidataItemUrl,
	wikidataTrackClaimsLookupUrl,
	wikidataTrackItemId,
	wikidataTrackItemLookupUrl,
	wikidataTrackMatch,
	youtubeVideoUrl,
} from './wikidata';

const itemSearch = { query: { search: [{ ns: 0, title: 'Q105978624', pageid: 101320679 }] } };
const statement = (value: string, rank = 'normal') => ({
	mainsnak: { snaktype: 'value', datavalue: { value, type: 'string' } },
	rank,
});
const itemClaims = {
	entities: {
		Q105978624: {
			claims: {
				P4404: [statement('e1ded706-16ec-45c3-87c4-0ae7a26f56d3')],
				P1651: [statement('oKqGUk5qCtU')],
				P6218: [statement('Complex-numbers-the-last-ring-lyrics')],
				P7212: [statement('complex-numbers-последнее-кольцо-lyrics.html')],
			},
		},
	},
};

describe('Wikidata track identifiers', () => {
	it('builds an exact P13289 Action API query for a numeric Yandex track ID', () => {
		const url = new URL(wikidataTrackItemLookupUrl('30233280')!);
		expect(`${url.origin}${url.pathname}`).toBe('https://www.wikidata.org/w/api.php');
		expect(url.searchParams.get('origin')).toBe('*');
		expect(url.searchParams.get('list')).toBe('search');
		expect(url.searchParams.get('srsearch')).toBe('haswbstatement:P13289=30233280');
		expect(url.searchParams.get('srnamespace')).toBe('0');
		expect(url.searchParams.get('srlimit')).toBe('1');
	});

	it('builds a single claims request for a validated item', () => {
		const url = new URL(wikidataTrackClaimsLookupUrl('Q105978624')!);
		expect(url.searchParams.get('action')).toBe('wbgetentities');
		expect(url.searchParams.get('ids')).toBe('Q105978624');
		expect(url.searchParams.get('props')).toBe('claims');
		expect(wikidataTrackClaimsLookupUrl('Property:P4404')).toBeUndefined();
	});

	it.each(['', 'track-1', '1 OR haswbstatement:*', '1/2', '1'.repeat(21)])(
		'rejects a non-numeric or implausibly long track ID (%s)',
		(trackId) => {
			expect(wikidataTrackItemLookupUrl(trackId)).toBeUndefined();
		},
	);

	it('extracts the first validated Wikidata item ID', () => {
		expect(wikidataTrackItemId(itemSearch)).toBe('Q105978624');
		expect(wikidataTrackItemId({ query: { search: [] } })).toBeUndefined();
		expect(wikidataTrackItemId({ query: { search: [{ title: 'Property:P13289' }] } })).toBeUndefined();
		expect(wikidataTrackItemId(null)).toBeUndefined();
	});

	it('extracts validated direct-link IDs from P4404, P1651, P6218, and P7212', () => {
		expect(wikidataTrackMatch(itemClaims, 'Q105978624')).toEqual({
			itemId: 'Q105978624',
			musicBrainzRecordingId: 'e1ded706-16ec-45c3-87c4-0ae7a26f56d3',
			youtubeVideoId: 'oKqGUk5qCtU',
			geniusId: 'Complex-numbers-the-last-ring-lyrics',
			lyricsTranslateId: 'complex-numbers-последнее-кольцо-lyrics.html',
		});
		expect(wikidataTrackMatch({ entities: {} }, 'Q105978624')).toBeUndefined();
	});

	it('ignores deprecated and malformed external IDs', () => {
		const payload = {
			entities: {
				Q1: {
					claims: {
						P4404: [statement('not-a-uuid')],
						P1651: [statement('oKqGUk5qCtU', 'deprecated')],
						P6218: [statement('../escape-lyrics')],
						P7212: [statement('../escape-lyrics.html')],
					},
				},
			},
		};
		expect(wikidataTrackMatch(payload, 'Q1')).toEqual({ itemId: 'Q1' });
	});

	it('builds only validated canonical direct links', () => {
		expect(wikidataItemUrl('Q105978624')).toBe('https://www.wikidata.org/wiki/Q105978624');
		expect(musicBrainzRecordingUrl('e1ded706-16ec-45c3-87c4-0ae7a26f56d3')).toBe(
			'https://musicbrainz.org/recording/e1ded706-16ec-45c3-87c4-0ae7a26f56d3',
		);
		expect(youtubeVideoUrl('oKqGUk5qCtU')).toBe('https://www.youtube.com/watch?v=oKqGUk5qCtU');
		expect(geniusPageUrl('Complex-numbers-the-last-ring-lyrics')).toBe(
			'https://genius.com/Complex-numbers-the-last-ring-lyrics',
		);
		const lyricsTranslate = new URL(lyricsTranslatePageUrl('complex-numbers-последнее-кольцо-lyrics.html')!);
		expect(lyricsTranslate.origin).toBe('https://lyricstranslate.com');
		expect(decodeURIComponent(lyricsTranslate.pathname)).toBe(
			'/complex-numbers-последнее-кольцо-lyrics.html',
		);
		expect(wikidataItemUrl('Q0')).toBeUndefined();
		expect(youtubeVideoUrl('../video-id')).toBeUndefined();
		expect(lyricsTranslatePageUrl('javascript:-lyrics.html')).toBeUndefined();
	});
});

describe('WikidataClient', () => {
	it('loads and memoizes one exact item and its direct-link claims', async () => {
		const transport: WikidataTransport = { request: vi.fn() };
		vi.mocked(transport.request).mockResolvedValueOnce(itemSearch).mockResolvedValueOnce(itemClaims);
		const client = new WikidataClient(transport);

		await expect(client.findTrack('30233280')).resolves.toMatchObject({ itemId: 'Q105978624' });
		await expect(client.findTrack('30233280')).resolves.toMatchObject({ itemId: 'Q105978624' });
		expect(transport.request).toHaveBeenCalledTimes(2);
	});

	it('memoizes a successful exact no-match', async () => {
		const transport: WikidataTransport = {
			request: vi.fn().mockResolvedValue({ query: { search: [] } }),
		};
		const client = new WikidataClient(transport);

		await expect(client.findTrack('60050452')).resolves.toBeUndefined();
		await expect(client.findTrack('60050452')).resolves.toBeUndefined();
		expect(transport.request).toHaveBeenCalledOnce();
	});

	it('does not request invalid IDs and retries transport failures', async () => {
		const transport: WikidataTransport = { request: vi.fn() };
		vi.mocked(transport.request)
			.mockRejectedValueOnce(new Error('Network unavailable'))
			.mockResolvedValueOnce(itemSearch)
			.mockResolvedValueOnce(itemClaims);
		const client = new WikidataClient(transport);

		await expect(client.findTrack('track/1')).resolves.toBeUndefined();
		expect(transport.request).not.toHaveBeenCalled();
		await expect(client.findTrack('30233280')).rejects.toThrow('Network unavailable');
		await expect(client.findTrack('30233280')).resolves.toMatchObject({ itemId: 'Q105978624' });
		expect(transport.request).toHaveBeenCalledTimes(3);
	});
});
