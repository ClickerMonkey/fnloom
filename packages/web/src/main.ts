/**
 * The web app's entry: the design system's styles, the stores, the router, the root, and the engines the shared
 * components draw with: Shiki for code (`HIGHLIGHTER`), mermaid for diagrams (`DIAGRAMS`) and pdf.js for pdf pages
 * (`PDF_DOCUMENTS`), each loaded lazily. Errors no component caught are sent to the hub's log of the person (`ClientLogs`).
 */
import { createApp } from 'vue';
import { createWebHistory } from 'vue-router';
import App from './app/App.vue';
import { createAppRouter } from './app/router.ts';
import { createStores } from './app/wire.ts';
import { STORES } from './state/stores.ts';
import { HIGHLIGHTER } from './ui/code/highlighter.ts';
import { ShikiHighlighter } from './ui/code/shiki.ts';
import { DIAGRAMS } from './ui/markdown/diagram.ts';
import { MermaidRenderer } from './ui/markdown/mermaid.ts';
import { PDF_DOCUMENTS, PdfJsDocuments } from './resources/logic/pdf.ts';
import { followThemeColour, openOutsideLinksInBrowser } from './app/standalone.ts';
import { registerWorker } from './state/install.ts';
import { SERVICE_WORKERS } from './state/push.ts';
import './ui/styles/tokens.css';
import './ui/styles/base.css';

const stores = createStores(window);
const app = createApp(App);
// an error no component caught goes to the hub's log of this person, and to the console as Vue would say it
app.config.errorHandler = (error) => {
  stores.logs.error(error, 'vue');
  console.error(error);
};
app
  .provide(STORES, stores)
  .provide(HIGHLIGHTER, new ShikiHighlighter())
  .provide(DIAGRAMS, new MermaidRenderer())
  .provide(PDF_DOCUMENTS, new PdfJsDocuments())
  .use(createAppRouter(stores.session, createWebHistory()))
  .mount('#app');

// the installed app: its service worker (push, and the offline page), outside links in the browser, the window's colour
void registerWorker(window, import.meta.env.DEV ? SERVICE_WORKERS.source : SERVICE_WORKERS.built);
openOutsideLinksInBrowser(window, () => stores.install.state.value === 'installed');
followThemeColour(document, stores.theme.theme);
