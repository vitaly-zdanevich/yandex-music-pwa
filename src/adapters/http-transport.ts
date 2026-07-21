import { MusicApiError, type MusicRequest, type MusicTransport } from '../sdk';
import { apiUrl } from './api-base';

interface ApiEnvelope<T> {
  result?: T;
  error?: string | { message?: string };
  errorDescription?: string;
}

export class HttpMusicTransport implements MusicTransport {
  async request<T>(request: MusicRequest): Promise<T> {
    const url = apiUrl(`/api/yandex${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers = new Headers({ Accept: 'application/json' });
    let body: string | undefined;
    if (request.body?.kind === 'json') {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(request.body.value);
    } else if (request.body?.kind === 'form') {
      headers.set('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
      const form = new URLSearchParams();
      for (const [key, rawValue] of Object.entries(request.body.value)) {
        for (const value of Array.isArray(rawValue) ? rawValue : [rawValue]) form.append(key, value);
      }
      body = form.toString();
    }

    let response: Response;
    try {
      response = await fetch(url, { method: request.method ?? 'GET', headers, body, cache: 'no-store' });
    } catch {
      throw new MusicApiError('Could not reach Yandex Music. Check your connection.');
    }

    let payload: ApiEnvelope<T>;
    try {
      payload = (await response.json()) as ApiEnvelope<T>;
    } catch {
      throw new MusicApiError('Yandex Music returned an unreadable response.', response.status);
    }
    if (!response.ok || payload.result === undefined) {
      const apiMessage = typeof payload.error === 'string' ? payload.error : payload.error?.message;
      const message =
        response.status === 401 || response.status === 403
          ? 'The token is invalid or has no Yandex Music access.'
          : apiMessage ?? payload.errorDescription ?? `Yandex Music request failed (${response.status}).`;
      throw new MusicApiError(message, response.status);
    }
    return payload.result;
  }
}
