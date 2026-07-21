import { afterEach, describe, expect, it, vi } from 'vitest';
import { MusicApiError } from '../sdk';
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

	it('retains the final fetch rejection as the network error cause', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('window', { location: { origin: 'https://app.example' }, setTimeout });
		const failures = [
			new TypeError('first network failure'),
			new TypeError('second network failure'),
			new TypeError('third network failure'),
			new TypeError('fourth network failure'),
			new TypeError('final network failure'),
		];
		const fetchMock = vi.fn();
		for (const failure of failures) fetchMock.mockRejectedValueOnce(failure);
		vi.stubGlobal('fetch', fetchMock);

		const result = new HttpMusicTransport()
			.request({ path: '/account/status', retry: 'transient' })
			.catch((error: unknown) => error);
		await vi.runAllTimersAsync();

		const error = await result;
		expect(error).toBeInstanceOf(MusicApiError);
		expect((error as MusicApiError).cause).toBe(failures.at(-1));
		expect((error as MusicApiError).status).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(5);
	});

	it('retains the JSON failure from an unreadable response', async () => {
		vi.stubGlobal('window', { location: { origin: 'https://app.example' } });
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
			new Response('not json', { status: 502, headers: { 'Content-Type': 'application/json' } }),
		));

		const error = await new HttpMusicTransport()
			.request({ path: '/account/status' })
			.catch((failure: unknown) => failure);

		expect(error).toMatchObject({
			message: 'Yandex Music returned an unreadable response.',
			status: 502,
		});
		expect((error as MusicApiError).cause).toBeInstanceOf(SyntaxError);
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
