/** The preview page's entry: the chat's theme and every fs renderer. */
import '../../../../packages/web/src/ui/styles/tokens.css';
import '../../../../packages/web/src/ui/styles/base.css';
import { createApp } from 'vue';
import Preview from './Preview.vue';

// typescript-eslint can't see the types of .vue modules from .ts files (as for packages/web/src/main.ts); vue-tsc checks it
// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
createApp(Preview).mount('#app');
