import { registerSW } from 'virtual:pwa-register';
import { App } from './app';
import './styles.css';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('App root not found');

registerSW({ immediate: true });

const app = new App(root);
void app.init();
