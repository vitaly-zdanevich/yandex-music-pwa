import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateStorageCapacity, type StorageEstimateSource } from './storage-capacity';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('estimateStorageCapacity', () => {
	it('returns the validated usage, quota, and remaining byte counts', async () => {
		const source: StorageEstimateSource = {
			estimate: vi.fn().mockResolvedValue({ usage: 250, quota: 1_000 }),
		};

		await expect(estimateStorageCapacity(source)).resolves.toEqual({
			usageBytes: 250,
			quotaBytes: 1_000,
			availableBytes: 750,
		});
		expect(source.estimate).toHaveBeenCalledOnce();
	});

	it('feature-detects the browser storage estimate source by default', async () => {
		const estimate = vi.fn().mockResolvedValue({ usage: 400, quota: 2_000 });
		vi.stubGlobal('navigator', { storage: { estimate } });

		await expect(estimateStorageCapacity()).resolves.toEqual({
			usageBytes: 400,
			quotaBytes: 2_000,
			availableBytes: 1_600,
		});
		expect(estimate).toHaveBeenCalledOnce();
	});

	it('clamps available bytes to zero when reported usage exceeds quota', async () => {
		await expect(estimateStorageCapacity({
			estimate: () => ({ usage: 1_250, quota: 1_000 }),
		})).resolves.toEqual({
			usageBytes: 1_250,
			quotaBytes: 1_000,
			availableBytes: 0,
		});
	});

	it.each([
		null,
		{},
		{ estimate: undefined },
	] satisfies Array<StorageEstimateSource | null>)('returns undefined when estimate() is unavailable', async (source) => {
		await expect(estimateStorageCapacity(source)).resolves.toBeUndefined();
	});

	it.each([
		{},
		{ usage: undefined, quota: 1_000 },
		{ usage: 100, quota: undefined },
		{ usage: -1, quota: 1_000 },
		{ usage: 100, quota: -1 },
		{ usage: Number.NaN, quota: 1_000 },
		{ usage: 100, quota: Number.POSITIVE_INFINITY },
	])('returns undefined for an invalid estimate %#', async (estimate) => {
		await expect(estimateStorageCapacity({ estimate: () => estimate })).resolves.toBeUndefined();
	});

	it('returns undefined instead of throwing when estimate() rejects', async () => {
		await expect(estimateStorageCapacity({
			estimate: vi.fn().mockRejectedValue(new DOMException('Storage estimate unavailable')),
		})).resolves.toBeUndefined();
	});

	it('returns undefined instead of throwing when estimate access fails', async () => {
		const source = Object.defineProperty({}, 'estimate', {
			get: () => {
				throw new DOMException('Storage API blocked');
			},
		}) as StorageEstimateSource;

		await expect(estimateStorageCapacity(source)).resolves.toBeUndefined();
	});
});
