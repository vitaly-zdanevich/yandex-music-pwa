import { MusicApiError } from '../sdk';
import { apiUrl } from './api-base';

export class SettingsClient {
	async status(): Promise<boolean> {
		const response = await fetch(apiUrl('/api/settings/status'), { cache: 'no-store' });
		let payload: { configured?: boolean; error?: string };
		try {
			payload = (await response.json()) as { configured?: boolean; error?: string };
		} catch (error) {
			throw new MusicApiError('The proxy settings response was unreadable.', response.status, undefined, error);
		}
		if (!response.ok) throw new MusicApiError(payload.error ?? 'Could not read proxy settings.', response.status);
		return payload.configured === true;
	}
}
