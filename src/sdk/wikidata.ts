const YANDEX_TRACK_ID_PATTERN = /^\d{1,20}$/;
const WIKIDATA_ITEM_ID_PATTERN = /^Q[1-9]\d*$/;
const MUSICBRAINZ_RECORDING_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YOUTUBE_VIDEO_ID_PATTERN = /^[-_0-9A-Za-z]{11}$/;
const GENIUS_ID_PATTERN = /^[0-9A-Z][0-9A-Za-z-]*-(?:lyrics|annotated)$/;
const LYRICS_TRANSLATE_ID_PATTERN = /^[^\s/\\.:?#]+-lyrics\.html(?:-\d{1,2})?$/u;
const MAX_CACHED_TRACKS = 256;

export interface WikidataTransport {
	request(url: string, signal?: AbortSignal): Promise<unknown>;
}

export interface WikidataTrackMatch {
	itemId: string;
	musicBrainzRecordingId?: string;
	youtubeVideoId?: string;
	geniusId?: string;
	lyricsTranslateId?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function actionApiUrl(): URL {
	const url = new URL('https://www.wikidata.org/w/api.php');
	url.searchParams.set('format', 'json');
	url.searchParams.set('formatversion', '2');
	url.searchParams.set('origin', '*');
	return url;
}

/** Builds an exact Wikidata statement lookup for Yandex Music track ID (P13289). */
export function wikidataTrackItemLookupUrl(trackId: string): string | undefined {
	if (!YANDEX_TRACK_ID_PATTERN.test(trackId)) return undefined;
	const url = actionApiUrl();
	url.searchParams.set('action', 'query');
	url.searchParams.set('list', 'search');
	url.searchParams.set('srsearch', `haswbstatement:P13289=${trackId}`);
	url.searchParams.set('srnamespace', '0');
	url.searchParams.set('srlimit', '1');
	url.searchParams.set('srprop', '');
	return url.toString();
}

/** Builds one entity request for the external-ID claims used to enrich track links. */
export function wikidataTrackClaimsLookupUrl(itemId: string): string | undefined {
	if (!WIKIDATA_ITEM_ID_PATTERN.test(itemId)) return undefined;
	const url = actionApiUrl();
	url.searchParams.set('action', 'wbgetentities');
	url.searchParams.set('ids', itemId);
	url.searchParams.set('props', 'claims');
	return url.toString();
}

/** Extracts a validated item ID from a Wikidata Action API search response. */
export function wikidataTrackItemId(payload: unknown): string | undefined {
	const search = record(record(payload)?.query)?.search;
	if (!Array.isArray(search)) return undefined;
	for (const result of search) {
		const title = record(result)?.title;
		if (typeof title === 'string' && WIKIDATA_ITEM_ID_PATTERN.test(title)) return title;
	}
	return undefined;
}

function claimValue(claims: unknown, property: string): string | undefined {
	const statements = record(claims)?.[property];
	if (!Array.isArray(statements)) return undefined;
	const active = statements.filter((statement) => record(statement)?.rank !== 'deprecated');
	const statement = active.find((candidate) => record(candidate)?.rank === 'preferred') ?? active[0];
	const mainsnak = record(record(statement)?.mainsnak);
	if (mainsnak?.snaktype !== 'value') return undefined;
	const value = record(mainsnak.datavalue)?.value;
	return typeof value === 'string' ? value : undefined;
}

/** Extracts and validates the supported direct-link identifiers from one item response. */
export function wikidataTrackMatch(payload: unknown, itemId: string): WikidataTrackMatch | undefined {
	if (!WIKIDATA_ITEM_ID_PATTERN.test(itemId)) return undefined;
	const entity = record(record(payload)?.entities)?.[itemId];
	const claims = record(entity)?.claims;
	if (!claims) return undefined;
	const musicBrainzRecordingId = claimValue(claims, 'P4404');
	const youtubeVideoId = claimValue(claims, 'P1651');
	const geniusId = claimValue(claims, 'P6218');
	const lyricsTranslateId = claimValue(claims, 'P7212');
	return {
		itemId,
		musicBrainzRecordingId:
			musicBrainzRecordingId && MUSICBRAINZ_RECORDING_ID_PATTERN.test(musicBrainzRecordingId)
				? musicBrainzRecordingId.toLowerCase()
				: undefined,
		youtubeVideoId:
			youtubeVideoId && YOUTUBE_VIDEO_ID_PATTERN.test(youtubeVideoId) ? youtubeVideoId : undefined,
		geniusId: geniusId && GENIUS_ID_PATTERN.test(geniusId) ? geniusId : undefined,
		lyricsTranslateId:
			lyricsTranslateId && LYRICS_TRANSLATE_ID_PATTERN.test(lyricsTranslateId) ? lyricsTranslateId : undefined,
	};
}

/** Returns the canonical page for a validated Wikidata item ID. */
export function wikidataItemUrl(itemId: string): string | undefined {
	return WIKIDATA_ITEM_ID_PATTERN.test(itemId) ? `https://www.wikidata.org/wiki/${itemId}` : undefined;
}

export function musicBrainzRecordingUrl(recordingId: string): string | undefined {
	return MUSICBRAINZ_RECORDING_ID_PATTERN.test(recordingId)
		? `https://musicbrainz.org/recording/${recordingId.toLowerCase()}`
		: undefined;
}

export function youtubeVideoUrl(videoId: string): string | undefined {
	if (!YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) return undefined;
	const url = new URL('https://www.youtube.com/watch');
	url.searchParams.set('v', videoId);
	return url.toString();
}

export function geniusPageUrl(geniusId: string): string | undefined {
	return GENIUS_ID_PATTERN.test(geniusId) ? `https://genius.com/${geniusId}` : undefined;
}

export function lyricsTranslatePageUrl(lyricsTranslateId: string): string | undefined {
	return LYRICS_TRANSLATE_ID_PATTERN.test(lyricsTranslateId)
		? new URL(`https://lyricstranslate.com/${lyricsTranslateId}`).toString()
		: undefined;
}

export class WikidataClient {
	private readonly cache = new Map<string, WikidataTrackMatch | null>();

	constructor(private readonly transport: WikidataTransport) {}

	async findTrack(trackId: string, signal?: AbortSignal): Promise<WikidataTrackMatch | undefined> {
		const requestUrl = wikidataTrackItemLookupUrl(trackId);
		if (!requestUrl) return undefined;
		if (this.cache.has(trackId)) return this.cache.get(trackId) ?? undefined;

		const itemId = wikidataTrackItemId(await this.transport.request(requestUrl, signal));
		if (signal?.aborted) return undefined;
		if (!itemId) {
			this.remember(trackId, null);
			return undefined;
		}

		const claimsUrl = wikidataTrackClaimsLookupUrl(itemId);
		if (!claimsUrl) return undefined;
		const match = wikidataTrackMatch(await this.transport.request(claimsUrl, signal), itemId);
		if (signal?.aborted || !match) return undefined;
		this.remember(trackId, match);
		return match;
	}

	private remember(trackId: string, match: WikidataTrackMatch | null): void {
		if (!this.cache.has(trackId) && this.cache.size >= MAX_CACHED_TRACKS) {
			const oldest = this.cache.keys().next().value as string | undefined;
			if (oldest !== undefined) this.cache.delete(oldest);
		}
		this.cache.set(trackId, match);
	}
}
