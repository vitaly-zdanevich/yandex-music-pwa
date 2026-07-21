import { registerSW } from 'virtual:pwa-register';
import { isClientAllowed } from './access-policy';
import { App } from './app';
import './styles.css';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('App root not found');

if (
	isClientAllowed({
		userAgent: navigator.userAgent,
		screenWidth: window.screen.width,
		screenHeight: window.screen.height,
	})
) {
	registerSW({ immediate: true });
	const app = new App(root);
	void app.init();
} else {
	document.title = 'Private player';
	root.innerHTML = `
		<main class="access-blocked" aria-labelledby="access-blocked-title">
			<div class="access-blocked-card">
				<span class="access-blocked-mark" aria-hidden="true">♪</span>
				<p class="eyebrow">Private player</p>
				<h1 id="access-blocked-title">This device is not enabled</h1>
				<p>The music player is restricted to its configured device.</p>
			</div>
		</main>
	`;
	if ('serviceWorker' in navigator) {
		void navigator.serviceWorker
			.getRegistration()
			.then((registration) => registration?.unregister())
			.catch(() => undefined);
	}
}
