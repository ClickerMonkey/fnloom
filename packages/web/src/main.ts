/**
 * The web app's entry: the design system's styles, the stores, the router, the root, and the engines the shared
 * components draw with: Shiki for code (`HIGHLIGHTER`), mermaid for diagrams (`DIAGRAMS`) and pdf.js for pdf pages
 * (`PDF_DOCUMENTS`), each loaded lazily.
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
import './ui/styles/tokens.css';
import './ui/styles/base.css';

const stores = createStores(window);
createApp(App)
  .provide(STORES, stores)
  .provide(HIGHLIGHTER, new ShikiHighlighter())
  .provide(DIAGRAMS, new MermaidRenderer())
  .provide(PDF_DOCUMENTS, new PdfJsDocuments())
  .use(createAppRouter(stores.session, createWebHistory()))
  .mount('#app');
