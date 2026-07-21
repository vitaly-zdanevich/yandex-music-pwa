const GITHUB_OWNER = 'vitaly-zdanevich';
const GITHUB_REPOSITORY = 'yandex-music-pwa';
const GITHUB_REPOSITORY_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPOSITORY}`;
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/commits?per_page=10`;
const CACHE_KEY = `${GITHUB_REPOSITORY}:github-history:v1`;
const CACHE_TTL_MS = 10 * 60 * 1000;
const FULL_SHA = /^[0-9a-f]{40}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface GithubHistoryEntry {
	readonly sha: string;
	readonly shortSha: string;
	readonly subject: string;
	readonly date: string;
	readonly version: string;
	readonly url: string;
}

interface GithubCommit {
	readonly sha: string;
	readonly subject: string;
	readonly date: string;
}

interface CachedHistory {
	readonly cachedAt: number;
	readonly entries: readonly GithubHistoryEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== 'string') throw new Error(`Invalid GitHub ${field}`);
	return value;
}

function commitDate(commit: Record<string, unknown>): string {
	const committer = isRecord(commit.committer) ? commit.committer : undefined;
	const author = isRecord(commit.author) ? commit.author : undefined;
	const timestamp = typeof committer?.date === 'string'
		? committer.date
		: typeof author?.date === 'string'
			? author.date
			: '';
	const date = timestamp.slice(0, 10);
	if (!ISO_DATE.test(date)) throw new Error('Invalid GitHub commit date');
	return date;
}

function parseCommit(value: unknown): GithubCommit {
	if (!isRecord(value) || !isRecord(value.commit)) throw new Error('Invalid GitHub commit');
	const sha = requiredString(value.sha, 'commit SHA').toLowerCase();
	if (!FULL_SHA.test(sha)) throw new Error('Invalid GitHub commit SHA');
	const message = requiredString(value.commit.message, 'commit message');
	return Object.freeze({
		sha,
		subject: (message.split(/[\r\n]/, 1)[0] ?? '').trim(),
		date: commitDate(value.commit),
	});
}

function parseVersion(value: unknown): string {
	if (!isRecord(value) || typeof value.version !== 'string' || !value.version.trim()) {
		throw new Error('Invalid package version');
	}
	return value.version.trim();
}

function isHistoryEntry(value: unknown): value is GithubHistoryEntry {
	if (!isRecord(value)) return false;
	if (typeof value.sha !== 'string' || !FULL_SHA.test(value.sha)) return false;
	const expectedUrl = `${GITHUB_REPOSITORY_URL}/commit/${value.sha}`;
	return value.shortSha === value.sha.slice(0, 7)
		&& typeof value.subject === 'string'
		&& typeof value.date === 'string'
		&& ISO_DATE.test(value.date)
		&& typeof value.version === 'string'
		&& value.version.length > 0
		&& value.url === expectedUrl;
}

function sessionStorageOrNull(): Storage | null {
	try {
		return typeof sessionStorage === 'undefined' ? null : sessionStorage;
	} catch {
		return null;
	}
}

function readCache(storage: Storage | null, now: number): readonly GithubHistoryEntry[] | null {
	if (!storage) return null;
	try {
		const serialized = storage.getItem(CACHE_KEY);
		if (!serialized) return null;
		const value: unknown = JSON.parse(serialized);
		if (!isRecord(value) || typeof value.cachedAt !== 'number' || !Array.isArray(value.entries)) return null;
		const age = now - value.cachedAt;
		if (!Number.isFinite(value.cachedAt) || age < 0 || age >= CACHE_TTL_MS) return null;
		if (!value.entries.every(isHistoryEntry)) return null;
		return Object.freeze(value.entries.map((entry) => Object.freeze({ ...entry })));
	} catch {
		return null;
	}
}

function writeCache(storage: Storage | null, value: CachedHistory): void {
	if (!storage) return;
	try {
		storage.setItem(CACHE_KEY, JSON.stringify(value));
	} catch {
		// History remains usable when session storage is disabled or full.
	}
}

async function fetchVersion(sha: string): Promise<string> {
	const response = await fetch(
		`https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/${sha}/package.json`,
		{ cache: 'no-store' },
	);
	if (!response.ok) throw new Error(`GitHub package request failed (${response.status})`);
	return parseVersion(await response.json() as unknown);
}

async function fetchHistory(): Promise<readonly GithubHistoryEntry[]> {
	const response = await fetch(GITHUB_API_URL, {
		cache: 'no-store',
		headers: { Accept: 'application/vnd.github+json' },
	});
	if (!response.ok) throw new Error(`GitHub history request failed (${response.status})`);
	const payload: unknown = await response.json();
	if (!Array.isArray(payload)) throw new Error('Invalid GitHub history response');

	const commits = payload.map(parseCommit);
	const versions = await Promise.all(commits.map((commit) => fetchVersion(commit.sha)));
	return Object.freeze(commits.map((commit, index) => Object.freeze({
		sha: commit.sha,
		shortSha: commit.sha.slice(0, 7),
		subject: commit.subject,
		date: commit.date,
		version: versions[index]!,
		url: `${GITHUB_REPOSITORY_URL}/commit/${commit.sha}`,
	})));
}

export async function loadGithubHistory(): Promise<readonly GithubHistoryEntry[]> {
	const storage = sessionStorageOrNull();
	const cached = readCache(storage, Date.now());
	if (cached) return cached;

	const entries = await fetchHistory();
	writeCache(storage, { cachedAt: Date.now(), entries });
	return entries;
}
