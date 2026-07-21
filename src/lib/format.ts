export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB'];
	const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	const value = bytes / 1024 ** exponent;
	return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

export function formatTime(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
	const whole = Math.floor(seconds);
	const minutes = Math.floor(whole / 60);
	return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}

export function artistNames(track: { artists: { name: string }[] }): string {
	return track.artists.map((artist) => artist.name).filter(Boolean).join(', ') || 'Unknown artist';
}

export interface MediaQualityDetails {
	codec?: string;
	bitrate?: number;
	quality?: string;
	size?: number;
}

export function formatMediaQuality(media: MediaQualityDetails, durationMs: number): string {
	const codec = media.codec?.trim() ? media.codec.toUpperCase() : 'AUDIO';
	const exactSize = Number.isFinite(media.size) && (media.size ?? 0) > 0 ? media.size : undefined;
	let bitrate = Math.max(0, Math.round(media.bitrate ?? 0));
	if (bitrate === 0 && exactSize && durationMs > 0) bitrate = Math.round((exactSize * 8) / durationMs);
	const estimatedSize = !exactSize && bitrate > 0 && durationMs > 0
		? (bitrate * durationMs) / 8
		: undefined;
	const label = media.quality === 'lossless' ? 'Lossless' : 'Highest available';
	const parts = [label, codec];
	if (bitrate > 0) parts.push(`${bitrate} kbps`);
	if (exactSize) parts.push(formatBytes(exactSize));
	else if (estimatedSize) parts.push(`≈${formatBytes(estimatedSize)}`);
	return parts.join(' · ');
}
