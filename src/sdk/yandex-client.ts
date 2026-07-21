import type {
	Account,
	Feedback,
	LikedTrackPage,
	MusicTransport,
	RecommendationBatch,
	RecommendedTrack,
	Track,
} from './types';

interface RawArtist {
	id?: string | number;
	name?: string;
}

interface RawAlbum {
	id?: string | number;
	title?: string;
}

interface RawTrack {
	id?: string | number;
	title?: string;
	artists?: RawArtist[];
	albums?: RawAlbum[];
	durationMs?: number;
	coverUri?: string;
	ogImage?: string;
	available?: boolean;
}

interface RawSequenceItem {
	type?: string;
	liked?: boolean;
	track?: RawTrack;
}

interface RawRecommendationBatch {
	radioSessionId?: string;
	batchId?: string;
	sequence?: RawSequenceItem[];
}

interface RawAccountStatus {
	account?: {
		uid?: string | number;
		displayName?: string;
		fullName?: string;
		login?: string;
	};
	uid?: string | number;
}

interface RawTrackShort {
	id?: string | number;
	albumId?: string | number;
	track?: RawTrack;
}

interface RawTracksList {
	tracks?: RawTrackShort[];
	library?: {
		tracks?: RawTrackShort[];
	};
}

const RECOMMENDATION_SEED = 'user:onyourwave';

export class YandexMusicClient {
	constructor(private readonly transport: MusicTransport) {}

	async getAccount(): Promise<Account> {
		const result = await this.transport.request<RawAccountStatus>({ path: '/account/status' });
		const account = result.account;
		const uid = account?.uid ?? result.uid;
		if (uid === undefined || uid === null) throw new Error('Yandex Music did not return an account id');
		return {
			uid: String(uid),
			displayName: account?.displayName ?? account?.fullName ?? account?.login,
		};
	}

	async startRecommendations(): Promise<RecommendationBatch> {
		const result = await this.transport.request<RawRecommendationBatch>({
			path: '/rotor/session/new',
			method: 'POST',
			body: {
				kind: 'json',
				value: {
					seeds: [RECOMMENDATION_SEED],
					queue: [],
					includeTracksInResponse: true,
					includeWaveModel: true,
					interactive: true,
				},
			},
		});
		return mapRecommendationBatch(result);
	}

	async getMoreRecommendations(sessionId: string, queue: readonly string[]): Promise<RecommendationBatch> {
		const result = await this.transport.request<RawRecommendationBatch>({
			path: `/rotor/session/${encodeURIComponent(sessionId)}/tracks`,
			method: 'POST',
			body: { kind: 'json', value: { queue } },
		});
		return mapRecommendationBatch({ ...result, radioSessionId: result.radioSessionId ?? sessionId });
	}

	async *getLikedTrackPages(uid: string, pageSize = 100): AsyncGenerator<LikedTrackPage> {
		if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
			throw new Error('Liked-track page size must be between 1 and 100');
		}
		const list = await this.transport.request<RawTracksList>({
			path: `/users/${encodeURIComponent(uid)}/likes/tracks`,
		});
		const rawShorts = list.library?.tracks ?? list.tracks;
		const shorts = Array.isArray(rawShorts) ? rawShorts : [];
		let loaded = 0;

		if (shorts.length === 0) {
			yield { tracks: [], loaded: 0, total: 0, hasMore: false };
			return;
		}

		for (let offset = 0; offset < shorts.length; offset += pageSize) {
			const page = shorts.slice(offset, offset + pageSize);
			const missing = page.filter((item) => !item.track && item.id !== undefined);
			const fetchedById = new Map<string, RawTrack>();
			if (missing.length) {
				const ids = missing.map((item) =>
					item.albumId === undefined ? String(item.id) : `${item.id}:${item.albumId}`,
				);
				const fetched = await this.transport.request<Array<RawTrack | null>>({
					path: '/tracks',
					method: 'POST',
					body: { kind: 'form', value: { 'track-ids': ids.join(',') } },
				});
				if (Array.isArray(fetched)) {
					for (const track of fetched.filter(isRawTrack)) fetchedById.set(String(track.id), track);
				}
			}

			const tracks = page
				.map((item) => item.track ?? (item.id === undefined ? undefined : fetchedById.get(String(item.id))))
				.filter(isRawTrack)
				.map((track) => mapTrack(track, true));
			loaded += tracks.length;
			yield {
				tracks,
				loaded,
				total: shorts.length,
				hasMore: offset + pageSize < shorts.length,
			};
		}
	}

	async getLikedTracks(uid: string): Promise<Track[]> {
		const tracks: Track[] = [];
		for await (const page of this.getLikedTrackPages(uid)) tracks.push(...page.tracks);
		return tracks;
	}

	async setLiked(uid: string, trackId: string, liked: boolean): Promise<void> {
		const action = liked ? 'add-multiple' : 'remove';
		await this.transport.request({
			path: `/users/${encodeURIComponent(uid)}/likes/tracks/${action}`,
			method: 'POST',
			body: { kind: 'form', value: { 'track-ids': trackId } },
			retry: 'transient',
		});
	}

	async setDisliked(uid: string, trackId: string, disliked: boolean): Promise<void> {
		const action = disliked ? 'add-multiple' : 'remove';
		await this.transport.request({
			path: `/users/${encodeURIComponent(uid)}/dislikes/tracks/${action}`,
			method: 'POST',
			body: { kind: 'form', value: { 'track-ids': trackId } },
			retry: 'transient',
		});
	}

	async sendFeedback(sessionId: string, feedback: Feedback): Promise<void> {
		const event: Record<string, string | number> = {
			type: feedback.type,
			timestamp: new Date().toISOString(),
		};
		if (feedback.trackId) event.trackId = feedback.trackId;
		if (feedback.totalPlayedSeconds !== undefined) event.totalPlayedSeconds = feedback.totalPlayedSeconds;
		await this.transport.request({
			path: `/rotor/session/${encodeURIComponent(sessionId)}/feedback`,
			method: 'POST',
			body: { kind: 'json', value: { batchId: feedback.batchId, event } },
		});
	}
}

export function mapTrack(raw: RawTrack, liked = false): Track {
	if (raw.id === undefined || raw.id === null) throw new Error('Track has no id');
	const cover = raw.coverUri ?? raw.ogImage;
	return {
		id: String(raw.id),
		title: raw.title?.trim() || 'Untitled track',
		artists: Array.isArray(raw.artists)
			? raw.artists
					.filter((artist) => Boolean(artist?.name))
					.map((artist) => ({ id: artist.id === undefined ? undefined : String(artist.id), name: artist.name! }))
			: [],
		album: raw.albums?.[0]?.title
			? { id: raw.albums[0].id === undefined ? undefined : String(raw.albums[0].id), title: raw.albums[0].title }
			: undefined,
		durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : 0,
		artworkUrl: normalizeArtworkUrl(cover),
		liked,
		disliked: false,
	};
}

function mapRecommendationBatch(raw: RawRecommendationBatch): RecommendationBatch {
	if (!raw.radioSessionId || !raw.batchId) throw new Error('Yandex Music returned an incomplete radio session');
	const tracks: RecommendedTrack[] = [];
	for (const item of raw.sequence ?? []) {
		if (!item.track || (item.type && item.type !== 'track') || item.track.available === false) continue;
		try {
			tracks.push({ track: mapTrack(item.track, item.liked === true), batchId: raw.batchId });
		} catch {
			// Ignore malformed or non-track sequence nodes from the private API.
		}
	}
	return {
		sessionId: raw.radioSessionId,
		batchId: raw.batchId,
		tracks,
	};
}

function normalizeArtworkUrl(value?: string): string | undefined {
	if (!value) return undefined;
	const expanded = value.replace('%%', '400x400');
	if (expanded.startsWith('//')) return `https:${expanded}`;
	if (/^https?:\/\//.test(expanded)) return expanded.replace(/^http:/, 'https:');
	return `https://${expanded}`;
}

function isRawTrack(value: RawTrack | null | undefined): value is RawTrack {
	return Boolean(value && value.id !== undefined);
}
