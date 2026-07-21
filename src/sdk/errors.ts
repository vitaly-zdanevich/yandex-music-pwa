export class MusicApiError extends Error {
	declare readonly cause?: unknown;

	constructor(
		message: string,
		readonly status?: number,
		readonly code?: string,
		cause?: unknown,
	) {
		super(message);
		this.name = 'MusicApiError';
		if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause });
	}
}
