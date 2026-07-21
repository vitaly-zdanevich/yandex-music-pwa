import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadGithubHistory } from './github-history';

const API_URL = 'https://api.github.com/repos/vitaly-zdanevich/yandex-music-pwa/commits?per_page=10';
const RAW_ROOT = 'https://raw.githubusercontent.com/vitaly-zdanevich/yandex-music-pwa';

class MemoryStorage implements Storage {
	readonly values = new Map<string, string>();

	get length(): number {
		return this.values.size;
	}

	clear(): void {
		this.values.clear();
	}

	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	key(index: number): string | null {
		return [...this.values.keys()][index] ?? null;
	}

	removeItem(key: string): void {
		this.values.delete(key);
	}

	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

function githubCommit(sha: string, message: string, date: string, useAuthor = false): unknown {
	return {
		sha,
		html_url: 'javascript:ignored-by-the-loader',
		commit: {
			message,
			committer: useAuthor ? {} : { date },
			author: useAuthor ? { date } : {},
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('loadGithubHistory', () => {
	it('loads commit subjects, dates, safe URLs, and the version at every SHA', async () => {
		const storage = new MemoryStorage();
		const firstSha = 'a'.repeat(40);
		const secondSha = 'B'.repeat(40);
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === API_URL) {
				expect(init?.cache).toBe('no-store');
				expect(new Headers(init?.headers).get('Accept')).toBe('application/vnd.github+json');
				return jsonResponse([
					githubCommit(firstSha, 'First subject\nLong body', '2026-07-22T10:11:12Z'),
					githubCommit(secondSha, ' Second subject \r\nBody', '2026-07-21T01:02:03Z', true),
				]);
			}
			if (url === `${RAW_ROOT}/${firstSha}/package.json`) return jsonResponse({ version: '1.2.3' });
			if (url === `${RAW_ROOT}/${secondSha.toLowerCase()}/package.json`) {
				return jsonResponse({ version: '1.2.2' });
			}
			throw new Error(`Unexpected URL ${url}`);
		});
		vi.stubGlobal('sessionStorage', storage);
		vi.stubGlobal('fetch', fetchMock);

		await expect(loadGithubHistory()).resolves.toEqual([
			{
				sha: firstSha,
				shortSha: 'aaaaaaa',
				subject: 'First subject',
				date: '2026-07-22',
				version: '1.2.3',
				url: `https://github.com/vitaly-zdanevich/yandex-music-pwa/commit/${firstSha}`,
			},
			{
				sha: secondSha.toLowerCase(),
				shortSha: 'bbbbbbb',
				subject: 'Second subject',
				date: '2026-07-21',
				version: '1.2.2',
				url: `https://github.com/vitaly-zdanevich/yandex-music-pwa/commit/${secondSha.toLowerCase()}`,
			},
		]);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(storage.key(0)).toContain('yandex-music-pwa');
	});

	it('reuses a fresh, validated session cache for ten minutes', async () => {
		const storage = new MemoryStorage();
		const sha = 'c'.repeat(40);
		vi.spyOn(Date, 'now').mockReturnValue(20_000);
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input) === API_URL) {
				return jsonResponse([githubCommit(sha, 'Cached commit', '2026-07-20T00:00:00Z')]);
			}
			return jsonResponse({ version: '2.0.0' });
		});
		vi.stubGlobal('sessionStorage', storage);
		vi.stubGlobal('fetch', fetchMock);

		const first = await loadGithubHistory();
		vi.spyOn(Date, 'now').mockReturnValue(20_000 + 10 * 60 * 1000 - 1);
		const second = await loadGithubHistory();

		expect(second).toEqual(first);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it.each(['corrupt JSON', 'stale data'] as const)('falls back to the network for %s in the cache', async (kind) => {
		const storage = new MemoryStorage();
		const sha = 'd'.repeat(40);
		vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input) === API_URL) {
				return jsonResponse([githubCommit(sha, 'Fresh commit', '2026-07-19T00:00:00Z')]);
			}
			return jsonResponse({ version: '3.0.0' });
		});
		vi.stubGlobal('sessionStorage', storage);
		vi.stubGlobal('fetch', fetchMock);

		await loadGithubHistory();
		const key = storage.key(0)!;
		if (kind === 'corrupt JSON') {
			storage.setItem(key, '{not-json');
		} else {
			const cached = JSON.parse(storage.getItem(key)!) as { cachedAt: number };
			cached.cachedAt -= 10 * 60 * 1000;
			storage.setItem(key, JSON.stringify(cached));
		}

		await expect(loadGithubHistory()).resolves.toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it('rejects GitHub API and per-commit package failures for graceful caller handling', async () => {
		const sha = 'e'.repeat(40);
		const storage = new MemoryStorage();
		const apiFailure = vi.fn(async () => jsonResponse({ message: 'rate limited' }, 403));
		vi.stubGlobal('sessionStorage', storage);
		vi.stubGlobal('fetch', apiFailure);
		await expect(loadGithubHistory()).rejects.toThrow('GitHub history request failed (403)');

		const packageFailure = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input) === API_URL) {
				return jsonResponse([githubCommit(sha, 'Commit', '2026-07-18T00:00:00Z')]);
			}
			throw new TypeError('Network unavailable');
		});
		vi.stubGlobal('fetch', packageFailure);
		await expect(loadGithubHistory()).rejects.toThrow('Network unavailable');
		expect(storage.length).toBe(0);
	});

	it('rejects malformed API fields instead of returning unsafe links', async () => {
		const storage = new MemoryStorage();
		const fetchMock = vi.fn(async () => jsonResponse([
			githubCommit('../unsafe', 'Commit', '2026-07-17T00:00:00Z'),
		]));
		vi.stubGlobal('sessionStorage', storage);
		vi.stubGlobal('fetch', fetchMock);

		await expect(loadGithubHistory()).rejects.toThrow('Invalid GitHub commit SHA');
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(storage.length).toBe(0);
	});
});
