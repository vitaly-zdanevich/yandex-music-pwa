import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpMusicTransport } from './http-transport';

describe('HttpMusicTransport', () => {
  afterEach(() => vi.unstubAllGlobals());

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
});
