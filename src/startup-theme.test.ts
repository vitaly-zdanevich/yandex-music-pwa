import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const documentHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const paletteChunk = Buffer.from('PLTE');
const startupImages = [
	{ viewportWidth: 320, viewportHeight: 568, pixelRatio: 2, pixelWidth: 640, pixelHeight: 1136 },
	{ viewportWidth: 375, viewportHeight: 667, pixelRatio: 2, pixelWidth: 750, pixelHeight: 1334 },
	{ viewportWidth: 414, viewportHeight: 736, pixelRatio: 3, pixelWidth: 1242, pixelHeight: 2208 },
	{ viewportWidth: 375, viewportHeight: 812, pixelRatio: 3, pixelWidth: 1125, pixelHeight: 2436 },
	{ viewportWidth: 414, viewportHeight: 896, pixelRatio: 2, pixelWidth: 828, pixelHeight: 1792 },
	{ viewportWidth: 414, viewportHeight: 896, pixelRatio: 3, pixelWidth: 1242, pixelHeight: 2688 },
	{ viewportWidth: 360, viewportHeight: 780, pixelRatio: 3, pixelWidth: 1080, pixelHeight: 2340 },
	{ viewportWidth: 390, viewportHeight: 844, pixelRatio: 3, pixelWidth: 1170, pixelHeight: 2532 },
	{ viewportWidth: 428, viewportHeight: 926, pixelRatio: 3, pixelWidth: 1284, pixelHeight: 2778 },
] as const;

describe('startup theme', () => {
	it('paints the selected color scheme before the application loads', () => {
		const colorSchemeIndex = documentHtml.indexOf('<meta name="color-scheme" content="light dark"');
		const startupStyleIndex = documentHtml.indexOf('<style id="startup-theme">');
		const moduleIndex = documentHtml.indexOf('<script type="module"');

		expect(colorSchemeIndex).toBeGreaterThan(-1);
		expect(startupStyleIndex).toBeGreaterThan(colorSchemeIndex);
		expect(moduleIndex).toBeGreaterThan(startupStyleIndex);

		const startupStyles = documentHtml.slice(startupStyleIndex, documentHtml.indexOf('</style>', startupStyleIndex));
		expect(startupStyles).toContain('background: #f5f5f7;');
		expect(startupStyles).toContain('@media (prefers-color-scheme: dark)');
		expect(startupStyles.slice(startupStyles.indexOf('@media'))).toContain('background: #000;');
	});

	it('provides opaque theme-matched launch images for every iOS 15 iPhone viewport', () => {
		const links = documentHtml.match(/<link rel="apple-touch-startup-image"[^>]+\/>/g) ?? [];
		const moduleIndex = documentHtml.indexOf('<script type="module"');
		expect(links).toHaveLength(startupImages.length * 2);

		for (const image of startupImages) {
			const imageStem = `iphone-${image.pixelWidth}x${image.pixelHeight}`;
			expect(documentHtml.indexOf(`${imageStem}-light.png`)).toBeLessThan(
				documentHtml.indexOf(`${imageStem}-dark.png`),
			);
			for (const theme of ['light', 'dark'] as const) {
				const filename = `${imageStem}-${theme}.png`;
				const href = `%BASE_URL%startup/${filename}`;
				const media = [
					'screen',
					...(theme === 'dark' ? ['(prefers-color-scheme: dark)'] : []),
					`(device-width: ${image.viewportWidth}px)`,
					`(device-height: ${image.viewportHeight}px)`,
					`(-webkit-device-pixel-ratio: ${image.pixelRatio})`,
					'(orientation: portrait)',
				].join(' and ');
				const link = links.find((candidate) => candidate.includes(`href="${href}"`));
				expect(link).toContain(`media="${media}"`);
				expect(documentHtml.indexOf(link!)).toBeLessThan(moduleIndex);

				const png = readFileSync(new URL(`../public/startup/${filename}`, import.meta.url));
				expect(png.subarray(0, pngSignature.length)).toEqual(pngSignature);
				expect(png.readUInt32BE(16)).toBe(image.pixelWidth);
				expect(png.readUInt32BE(20)).toBe(image.pixelHeight);
				expect(png[25]).toBe(3);
				const paletteOffset = png.indexOf(paletteChunk);
				expect(paletteOffset).toBeGreaterThan(3);
				if (paletteOffset < 4) throw new Error(`No PNG palette in ${filename}`);
				expect(png.readUInt32BE(paletteOffset - 4)).toBe(3);
				expect(png.subarray(paletteOffset + 4, paletteOffset + 7).toString('hex')).toBe(
					theme === 'dark' ? '000000' : 'f5f5f7',
				);
				expect(png.indexOf(Buffer.from('tRNS'))).toBe(-1);
			}
		}
	});
});
