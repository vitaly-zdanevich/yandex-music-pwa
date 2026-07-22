import type { Track } from './types';

type TrackLinkDetails = Pick<Track, 'id' | 'title' | 'artists' | 'album'>;

const artistQuery = (track: Pick<TrackLinkDetails, 'artists'>): string =>
	track.artists
		.map(({ name }) => name.trim())
		.filter(Boolean)
		.join(' ');

const searchUrl = (baseUrl: string, parameter: string, query: string): string => {
	const url = new URL(baseUrl);
	url.searchParams.set(parameter, query);
	return url.toString();
};

const musicBrainzSearchUrl = (
	type: 'recording' | 'release_group' | 'artist',
	query: string,
): string => {
	const url = new URL('https://musicbrainz.org/search');
	url.searchParams.set('query', query);
	url.searchParams.set('type', type);
	url.searchParams.set('method', 'indexed');
	return url.toString();
};

const trackArtistQuery = (
	track: Pick<TrackLinkDetails, 'title' | 'artists'>,
): string => [track.title.trim(), artistQuery(track)].filter(Boolean).join(' ');

const albumArtistQuery = (
	track: Pick<TrackLinkDetails, 'artists' | 'album'>,
): string => [track.album?.title.trim(), artistQuery(track)].filter(Boolean).join(' ');

const trackAlbumArtistQuery = (
	track: Pick<TrackLinkDetails, 'title' | 'artists' | 'album'>,
): string =>
	[track.title.trim(), track.album?.title.trim(), artistQuery(track)]
		.filter((part): part is string => Boolean(part))
		.join(' ');

/** Returns the public Yandex Music page for a track. */
export function yandexMusicTrackUrl(track: Pick<TrackLinkDetails, 'id' | 'album'>): string {
	const trackId = encodeURIComponent(track.id);
	const albumId = track.album?.id?.trim();
	if (albumId) {
		return `https://music.yandex.ru/album/${encodeURIComponent(albumId)}/track/${trackId}`;
	}
	return `https://music.yandex.ru/track/${trackId}`;
}

/** Returns a Genius search for the artists and track title. */
export function geniusTrackSearchUrl(
	track: Pick<TrackLinkDetails, 'title' | 'artists'>,
): string {
	return searchUrl('https://genius.com/search', 'q', `${artistQuery(track)} ${track.title}`.trim());
}

/** Returns a LyricsTranslate search for the track title and artists. */
export function lyricsTranslateTrackSearchUrl(
	track: Pick<TrackLinkDetails, 'title' | 'artists'>,
): string {
	return searchUrl('https://lyricstranslate.com/site-search', 'query', trackArtistQuery(track));
}

/** Returns a Last.fm track search for the artists and track title. */
export function lastFmTrackSearchUrl(
	track: Pick<TrackLinkDetails, 'title' | 'artists'>,
): string {
	return searchUrl(
		'https://www.last.fm/search/tracks',
		'q',
		`${artistQuery(track)} ${track.title}`.trim(),
	);
}

/** Returns an English Wikipedia search for the track's artists. */
export function wikipediaArtistSearchUrl(track: Pick<TrackLinkDetails, 'artists'>): string {
	return searchUrl('https://en.wikipedia.org/w/index.php', 'search', artistQuery(track));
}

/** Returns a MusicBrainz recording search for the track title and artists. */
export function musicBrainzTrackSearchUrl(
	track: Pick<TrackLinkDetails, 'title' | 'artists'>,
): string {
	return musicBrainzSearchUrl('recording', trackArtistQuery(track));
}

/** Returns a MusicBrainz release-group search for the album title and artists. */
export function musicBrainzAlbumSearchUrl(
	track: Pick<TrackLinkDetails, 'artists' | 'album'>,
): string {
	return musicBrainzSearchUrl('release_group', albumArtistQuery(track));
}

/** Returns a MusicBrainz artist search for the track's artists. */
export function musicBrainzArtistSearchUrl(track: Pick<TrackLinkDetails, 'artists'>): string {
	return musicBrainzSearchUrl('artist', artistQuery(track));
}

/** Returns a Wikidata search for the track title and artists. */
export function wikidataTrackSearchUrl(
	track: Pick<TrackLinkDetails, 'title' | 'artists'>,
): string {
	return searchUrl('https://www.wikidata.org/w/index.php', 'search', trackArtistQuery(track));
}

/** Returns a Wikidata search for the album title and artists. */
export function wikidataAlbumSearchUrl(
	track: Pick<TrackLinkDetails, 'artists' | 'album'>,
): string {
	return searchUrl('https://www.wikidata.org/w/index.php', 'search', albumArtistQuery(track));
}

/** Returns a Wikidata search for the track's artists. */
export function wikidataArtistSearchUrl(track: Pick<TrackLinkDetails, 'artists'>): string {
	return searchUrl('https://www.wikidata.org/w/index.php', 'search', artistQuery(track));
}

/** Returns a YouTube search in track-title, album-title, artist-name order. */
export function youtubeTrackSearchUrl(
	track: Pick<TrackLinkDetails, 'title' | 'artists' | 'album'>,
): string {
	return searchUrl(
		'https://www.youtube.com/results',
		'search_query',
		trackAlbumArtistQuery(track),
	);
}

/** Returns a Google search in track-title, album-title, artist-name order. */
export function googleTrackSearchUrl(
	track: Pick<TrackLinkDetails, 'title' | 'artists' | 'album'>,
): string {
	return searchUrl('https://www.google.com/search', 'q', trackAlbumArtistQuery(track));
}
