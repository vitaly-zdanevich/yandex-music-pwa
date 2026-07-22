import { describe, expect, it } from 'vitest';
import type { Track } from './types';
import {
	geniusTrackSearchUrl,
	googleTrackSearchUrl,
	lastFmTrackSearchUrl,
	lyricsTranslateTrackSearchUrl,
	musicBrainzAlbumSearchUrl,
	musicBrainzArtistSearchUrl,
	musicBrainzTrackSearchUrl,
	wikidataAlbumSearchUrl,
	wikidataArtistSearchUrl,
	wikidataTrackSearchUrl,
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

	it('builds a LyricsTranslate search from the track title and artists', () => {
		const url = new URL(lyricsTranslateTrackSearchUrl(track));
		expect(`${url.origin}${url.pathname}`).toBe('https://lyricstranslate.com/site-search');
		expect(url.searchParams.get('query')).toBe('Song & Dance + Remix Artist One Артист / Two');
	});

	it('builds a Wikipedia search from the artist names', () => {
		const wikipedia = new URL(wikipediaArtistSearchUrl(track));
		expect(`${wikipedia.origin}${wikipedia.pathname}`).toBe('https://en.wikipedia.org/w/index.php');
		expect(wikipedia.searchParams.get('search')).toBe('Artist One Артист / Two');
	});

	it('builds MusicBrainz searches in track, album, artist order', () => {
		const searches = [
			new URL(musicBrainzTrackSearchUrl(track)),
			new URL(musicBrainzAlbumSearchUrl(track)),
			new URL(musicBrainzArtistSearchUrl(track)),
		];
		expect(searches.map(({ origin, pathname }) => `${origin}${pathname}`)).toEqual([
			'https://musicbrainz.org/search',
			'https://musicbrainz.org/search',
			'https://musicbrainz.org/search',
		]);
		expect(searches.map((url) => url.searchParams.get('type'))).toEqual([
			'recording',
			'release_group',
			'artist',
		]);
		expect(searches.map((url) => url.searchParams.get('method'))).toEqual([
			'indexed',
			'indexed',
			'indexed',
		]);
		expect(searches.map((url) => url.searchParams.get('query'))).toEqual([
			'Song & Dance + Remix Artist One Артист / Two',
			'An Album: Vol. 2 Artist One Артист / Two',
			'Artist One Артист / Two',
		]);
	});

	it('builds Wikidata searches in track, album, artist order', () => {
		const searches = [
			new URL(wikidataTrackSearchUrl(track)),
			new URL(wikidataAlbumSearchUrl(track)),
			new URL(wikidataArtistSearchUrl(track)),
		];
		expect(searches.map(({ origin, pathname }) => `${origin}${pathname}`)).toEqual([
			'https://www.wikidata.org/w/index.php',
			'https://www.wikidata.org/w/index.php',
			'https://www.wikidata.org/w/index.php',
		]);
		expect(searches.map((url) => url.searchParams.get('search'))).toEqual([
			'Song & Dance + Remix Artist One Артист / Two',
			'An Album: Vol. 2 Artist One Артист / Two',
			'Artist One Артист / Two',
		]);
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
		expect(new URL(lyricsTranslateTrackSearchUrl(sparse)).searchParams.get('query')).toBe('Track');
		expect(new URL(musicBrainzTrackSearchUrl(sparse)).searchParams.get('query')).toBe('Track');
		expect(new URL(musicBrainzAlbumSearchUrl(sparse)).searchParams.get('query')).toBe('');
		expect(new URL(musicBrainzArtistSearchUrl(sparse)).searchParams.get('query')).toBe('');
		expect(new URL(wikidataTrackSearchUrl(sparse)).searchParams.get('search')).toBe('Track');
		expect(new URL(wikidataAlbumSearchUrl(sparse)).searchParams.get('search')).toBe('');
		expect(new URL(wikidataArtistSearchUrl(sparse)).searchParams.get('search')).toBe('');
		expect(new URL(youtubeTrackSearchUrl(sparse)).searchParams.get('search_query')).toBe('Track');
		expect(new URL(googleTrackSearchUrl(sparse)).searchParams.get('q')).toBe('Track');
	});
});
