import { describe, expect, it } from 'vitest';
import { isClientAllowed, isIphoneIos15UserAgent, isLinuxFirefoxUserAgent } from './access-policy';

const iphone15 =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7_9 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1';
const ipad15 =
	'Mozilla/5.0 (iPad; CPU OS 15_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Mobile/15E148 Safari/604.1';
const ipod15 =
	'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const linuxFirefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0';

describe('client access policy', () => {
	it('accepts an iPhone on iOS 15', () => {
		expect(isIphoneIos15UserAgent(iphone15)).toBe(true);
	});

	it('rejects other iOS versions, Apple devices, and desktop Safari 15', () => {
		expect(isIphoneIos15UserAgent(iphone15.replace('OS 15_7_9', 'OS 14_8'))).toBe(false);
		expect(isIphoneIos15UserAgent(iphone15.replace('OS 15_7_9', 'OS 16_0'))).toBe(false);
		expect(isIphoneIos15UserAgent(ipad15)).toBe(false);
		expect(isIphoneIos15UserAgent(ipod15)).toBe(false);
		expect(
			isIphoneIos15UserAgent(
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/15.6 Safari/605.1.15',
			),
		).toBe(false);
		expect(
			isIphoneIos15UserAgent(
				'Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 Version/15.0 Mobile Safari/537.36',
			),
		).toBe(false);
	});

	it('accepts Linux Firefox at the exact fallback screen resolution', () => {
		expect(isLinuxFirefoxUserAgent(linuxFirefox)).toBe(true);
		expect(isClientAllowed({ userAgent: linuxFirefox, screenWidth: 1200, screenHeight: 1920 })).toBe(true);
	});

	it('rejects near screen matches and non-Linux Firefox clients', () => {
		expect(isClientAllowed({ userAgent: linuxFirefox, screenWidth: 1199, screenHeight: 1920 })).toBe(false);
		expect(isClientAllowed({ userAgent: linuxFirefox, screenWidth: 1200, screenHeight: 1919 })).toBe(false);
		expect(isClientAllowed({ userAgent: linuxFirefox, screenWidth: 1920, screenHeight: 1200 })).toBe(false);
		expect(
			isClientAllowed({
				userAgent: linuxFirefox.replace('X11; Linux x86_64', 'Macintosh; Intel Mac OS X 10.15'),
				screenWidth: 1200,
				screenHeight: 1920,
			}),
		).toBe(false);
		expect(isClientAllowed({ userAgent: 'Other browser', screenWidth: 1200, screenHeight: 1920 })).toBe(false);
	});

	it('allows an iPhone on iOS 15 at any screen size', () => {
		expect(isClientAllowed({ userAgent: iphone15, screenWidth: 1, screenHeight: 1 })).toBe(true);
	});
});
