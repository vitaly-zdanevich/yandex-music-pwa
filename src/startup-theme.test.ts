import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const documentHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

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
});
