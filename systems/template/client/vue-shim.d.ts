/**
 * What a `.vue` file is to TypeScript: `tsc -b` (which `fs/install_system` and `harness system build` run before they
 * bundle) can't read single-file components, so without this `import Page from './Page.vue'` fails with TS2307. Vite
 * compiles the file itself when it bundles the client; this only says that such an import is a Vue component. Keep it
 * while `client/` has any `.vue` file.
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  // a page's or renderer's props are its own (typed in the file by `defineProps`), so any props fit here
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const component: DefineComponent<any, any, any>;
  export default component;
}
