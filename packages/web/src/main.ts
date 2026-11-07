/** The web app's entry: the design system's styles, the stores, the router, the root. */
import { createApp } from 'vue';
import { createWebHistory } from 'vue-router';
import App from './app/App.vue';
import { createAppRouter } from './app/router.ts';
import { createStores } from './app/wire.ts';
import { STORES } from './state/stores.ts';
import './ui/styles/tokens.css';
import './ui/styles/base.css';

const stores = createStores(window);
createApp(App).provide(STORES, stores).use(createAppRouter(stores.session, createWebHistory())).mount('#app');
