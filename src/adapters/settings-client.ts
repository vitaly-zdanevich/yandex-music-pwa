import { MusicApiError } from '../sdk';
import { apiUrl } from './api-base';

export class SettingsClient {
  async status(): Promise<boolean> {
    const response = await fetch(apiUrl('/api/settings/status'), { cache: 'no-store' });
    const payload = (await response.json().catch(() => ({}))) as { configured?: boolean; error?: string };
    if (!response.ok) throw new MusicApiError(payload.error ?? 'Could not read proxy settings.', response.status);
    return payload.configured === true;
  }
}
