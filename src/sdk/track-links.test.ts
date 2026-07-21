import { describe, expect, it } from 'vitest';
import type { Track } from './types';
import {
	geniusTrackSearchUrl,
	googleTrackSearchUrl,
	lastFmTrackSearchUrl,
	wikidataArtistSearchUrl,
	wikipediaArtistSearchUrl,
	yandexMusicTrackUrl,
	youtubeTrackSearchUrl,
} from './track-links';

const track: Track = {
	id: 'track/42?',
	title: 'Song & Dance + Remix',
	artists: [{ name: 'Artist One' }, { name: 'Артист / Two' }],
	album: { id: 'album/7', title: 'An Album: Vol. 2' },
	durationMs: 180_000,
	liked: false,
	disliked: false,
};

describe('track links', () => {
	it('builds a canonical Yandex Music album and track page with encoded ids', () => {
		expect(yandexMusicTrackUrl(track)).toBe(
			'https://music.yandex.ru/album/album%2F7/track/track%2F42%3F',
		);
	});

	it('falls back to a track-only Yandex Music page without an album id', () => {
		expect(yandexMusicTrackUrl({ id: '42', album: { title: 'Unknown' } })).toBe(
			'https://music.yandex.ru/track/42',
		);
	});

	it('builds Genius and Last.fm searches from artist names followed by the track title', () => {
		const expectedQuery = 'Artist One Артист / Two Song & Dance + Remix';
		const genius = new URL(geniusTrackSearchUrl(track));
		const lastFm = new URL(lastFmTrackSearchUrl(track));

		expect(`${genius.origin}${genius.pathname}`).toBe('https://genius.com/search');
		expect(genius.searchParams.get('q')).toBe(expectedQuery);
		expect(`${lastFm.origin}${lastFm.pathname}`).toBe('https://www.last.fm/search/tracks');
		expect(lastFm.searchParams.get('q')).toBe(expectedQuery);
	});

	it('builds Wikipedia and Wikidata searches from the artist names', () => {
		const wikipedia = new URL(wikipediaArtistSearchUrl(track));
		const wikidata = new URL(wikidataArtistSearchUrl(track));
		expect(`${wikipedia.origin}${wikipedia.pathname}`).toBe('https://en.wikipedia.org/w/index.php');
		expect(wikipedia.searchParams.get('search')).toBe('Artist One Артист / Two');
		expect(`${wikidata.origin}${wikidata.pathname}`).toBe('https://www.wikidata.org/w/index.php');
		expect(wikidata.searchParams.get('search')).toBe('Artist One Артист / Two');
	});

	it('builds a YouTube search in track, album, artist order', () => {
		const url = new URL(youtubeTrackSearchUrl(track));
		expect(`${url.origin}${url.pathname}`).toBe('https://www.youtube.com/results');
		expect(url.searchParams.get('search_query')).toBe(
			'Song & Dance + Remix An Album: Vol. 2 Artist One Артист / Two',
		);
	});

	it('builds a Google search in track, album, artist order', () => {
		const url = new URL(googleTrackSearchUrl(track));
		expect(`${url.origin}${url.pathname}`).toBe('https://www.google.com/search');
		expect(url.searchParams.get('q')).toBe(
			'Song & Dance + Remix An Album: Vol. 2 Artist One Артист / Two',
		);
	});

	it('omits missing optional and blank search components cleanly', () => {
		const sparse = {
			title: 'Track',
			artists: [{ name: '  ' }],
		};
		expect(new URL(geniusTrackSearchUrl(sparse)).searchParams.get('q')).toBe('Track');
		expect(new URL(wikidataArtistSearchUrl(sparse)).searchParams.get('search')).toBe('');
		expect(new URL(youtubeTrackSearchUrl(sparse)).searchParams.get('search_query')).toBe('Track');
		expect(new URL(googleTrackSearchUrl(sparse)).searchParams.get('q')).toBe('Track');
	});
});
