import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const startup = vi.hoisted(() => ({
	appConstructor: vi.fn(),
	appInit: vi.fn(),
	registerSW: vi.fn(),
}));

vi.mock('virtual:pwa-register', () => ({ registerSW: startup.registerSW }));
vi.mock('./app', () => ({
	App: class MockApp {
		constructor(root: HTMLElement) {
			startup.appConstructor(root);
		}

		init(): void {
			startup.appInit();
		}
	},
}));

describe('application startup access gate', () => {
	let root: { innerHTML: string };
	let unregister: ReturnType<typeof vi.fn>;
	let getRegistration: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.resetModules();
		startup.appConstructor.mockReset();
		startup.appInit.mockReset();
		startup.registerSW.mockReset();
		root = { innerHTML: '' };
		unregister = vi.fn().mockResolvedValue(true);
		getRegistration = vi.fn().mockResolvedValue({ unregister });
		vi.stubGlobal('document', {
			querySelector: vi.fn(() => root),
			title: 'My Wave',
		});
		vi.stubGlobal('navigator', {
			userAgent:
				'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
			serviceWorker: { getRegistration },
		});
		vi.stubGlobal('window', { screen: { width: 1200, height: 1920 } });
		vi.stubGlobal('fetch', vi.fn());
	});

	afterEach(() => vi.unstubAllGlobals());

	it('blocks before service worker, app, or network startup', async () => {
		await import('./main');

		expect(startup.registerSW).not.toHaveBeenCalled();
		expect(startup.appConstructor).not.toHaveBeenCalled();
		expect(startup.appInit).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
		expect(root.innerHTML).toContain('This device is not enabled');
		expect(getRegistration).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(unregister).toHaveBeenCalledOnce());
	});

	it('starts at the exact fallback screen resolution', async () => {
		vi.stubGlobal('navigator', {
			userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0',
		});
		vi.stubGlobal('window', { screen: { width: 1200, height: 1920 } });

		await import('./main');

		expect(startup.registerSW).toHaveBeenCalledOnce();
		expect(startup.registerSW).toHaveBeenCalledWith({ immediate: true });
		expect(startup.appConstructor).toHaveBeenCalledWith(root);
		expect(startup.appInit).toHaveBeenCalledOnce();
	});

	it('starts on an iPhone running iOS 15 at any screen size', async () => {
		vi.stubGlobal('navigator', {
			userAgent:
				'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7_9 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1',
		});
		vi.stubGlobal('window', { screen: { width: 390, height: 844 } });

		await import('./main');

		expect(startup.registerSW).toHaveBeenCalledOnce();
		expect(startup.appConstructor).toHaveBeenCalledWith(root);
		expect(startup.appInit).toHaveBeenCalledOnce();
	});
});
