export interface Artist {
	id?: string;
	name: string;
}

export interface Album {
	id?: string;
	title: string;
}

export interface Track {
	id: string;
	title: string;
	artists: Artist[];
	album?: Album;
	durationMs: number;
	artworkUrl?: string;
	liked: boolean;
	disliked: boolean;
}

export interface RecommendedTrack {
	track: Track;
	batchId: string;
}

export interface RecommendationBatch {
	sessionId: string;
	batchId: string;
	tracks: RecommendedTrack[];
}

export interface Account {
	uid: string;
	displayName?: string;
}

export interface LikedTrackPage {
	tracks: Track[];
	loaded: number;
	total: number;
	hasMore: boolean;
}

export type FeedbackType =
	| 'radioStarted'
	| 'trackStarted'
	| 'trackFinished'
	| 'skip'
	| 'like'
	| 'dislike';

export interface Feedback {
	type: FeedbackType;
	batchId: string;
	trackId?: string;
	totalPlayedSeconds?: number;
}

export type RequestBody =
	| { kind: 'json'; value: unknown }
	| { kind: 'form'; value: Record<string, string | string[]> };

export interface MusicRequest {
	path: string;
	method?: 'GET' | 'POST';
	query?: Record<string, string | number | boolean | undefined>;
	body?: RequestBody;
}

export interface MusicTransport {
	request<T>(request: MusicRequest): Promise<T>;
}

export interface RecommendationClient {
	startRecommendations(): Promise<RecommendationBatch>;
	getMoreRecommendations(sessionId: string, queue: readonly string[]): Promise<RecommendationBatch>;
}
