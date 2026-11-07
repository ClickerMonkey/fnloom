/** The web app's entry: Vue, the router, the theme. */
import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router.ts';
import './styles/theme.css';

createApp(App).use(router).mount('#app');
