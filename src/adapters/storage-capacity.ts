export interface StorageEstimateResult {
	usage?: number;
	quota?: number;
}

export interface StorageEstimateSource {
	estimate?: () => PromiseLike<StorageEstimateResult> | StorageEstimateResult;
}

export interface StorageCapacity {
	usageBytes: number;
	quotaBytes: number;
	availableBytes: number;
}

function browserStorageSource(): StorageEstimateSource | undefined {
	try {
		if (typeof navigator === 'undefined') return undefined;
		return navigator.storage;
	} catch {
		return undefined;
	}
}

function isValidByteCount(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export async function estimateStorageCapacity(
	source: StorageEstimateSource | null | undefined = browserStorageSource(),
): Promise<StorageCapacity | undefined> {
	try {
		if (typeof source?.estimate !== 'function') return undefined;

		const estimate = await source.estimate();
		if (!isValidByteCount(estimate?.usage) || !isValidByteCount(estimate.quota)) return undefined;

		return {
			usageBytes: estimate.usage,
			quotaBytes: estimate.quota,
			availableBytes: Math.max(0, estimate.quota - estimate.usage),
		};
	} catch {
		return undefined;
	}
}
