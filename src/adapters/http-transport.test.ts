import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpMusicTransport } from './http-transport';

describe('HttpMusicTransport', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('never places a Yandex token in browser requests', async () => {
		vi.stubGlobal('window', { location: { origin: 'https://app.example' } });
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, _options?: RequestInit) =>
			new Response(JSON.stringify({ result: { account: { uid: 1 } } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		vi.stubGlobal('fetch', fetchMock);

		await new HttpMusicTransport().request({ path: '/account/status' });

		const [requestUrl, options] = fetchMock.mock.calls[0]!;
		expect(String(requestUrl)).toBe('https://app.example/api/yandex/account/status');
		expect(String(requestUrl)).not.toContain('token');
		expect(new Headers(options?.headers).has('Authorization')).toBe(false);
	});

	it('retries a persistent reaction after hidden and visible Lambda throttles', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('window', { location: { origin: 'https://app.example' }, setTimeout });
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('CORS blocked the Lambda throttle response'))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ message: 'Rate Exceeded.' }), {
					status: 429,
					headers: { 'Content-Type': 'application/json' },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ result: { revision: 2 } }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
			);
		vi.stubGlobal('fetch', fetchMock);

		const reaction = new HttpMusicTransport().request({
			path: '/users/10/likes/tracks/add-multiple',
			method: 'POST',
			body: { kind: 'form', value: { 'track-ids': '20' } },
			retry: 'transient',
		});
		await vi.advanceTimersByTimeAsync(250);
		await vi.advanceTimersByTimeAsync(750);

		await expect(reaction).resolves.toEqual({ revision: 2 });
		expect(fetchMock).toHaveBeenCalledTimes(3);
		const [, options] = fetchMock.mock.calls[2]!;
		expect(options?.body).toBe('track-ids=20');
	});

	it('does not repeat requests that are not explicitly idempotent', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('window', { location: { origin: 'https://app.example' }, setTimeout });
		const fetchMock = vi.fn().mockRejectedValue(new TypeError('Network failed'));
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			new HttpMusicTransport().request({
				path: '/rotor/session/1/feedback',
				method: 'POST',
				body: { kind: 'json', value: { event: { type: 'like' } } },
			}),
		).rejects.toThrow('Could not reach Yandex Music');
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it('does not retry authentication failures', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('window', { location: { origin: 'https://app.example' }, setTimeout });
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ error: 'Unauthorized' }), {
				status: 401,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			new HttpMusicTransport().request({ path: '/account/status', retry: 'transient' }),
		).rejects.toThrow('The token is invalid');
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
