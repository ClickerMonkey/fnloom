// Lint rules. The type system does most of the work; these keep it honest: no `any`, no unchecked casts (`as` is
// refused except `as const`; the few justified casts carry an eslint-disable comment saying why), no floating
// promises, and type-only imports where possible.
import js from '@eslint/js';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['eslint.config.js', 'types/**', 'explorer/**', '**/node_modules/**', '**/dist/**', '.types/**', 'coverage/**', 'explorer/explorer.html', 'packages/web/src/api/manifest.gen.ts', '.harness/**', '**/.harness-test/**', 'ui-tests/shots/**', 'packages/web/e2e/shots/**',
    // the CLI's launcher: plain JS that registers tsx and imports the typed entry
    'packages/cli/bin/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...vue.configs['flat/recommended'],
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname, extraFileExtensions: ['.vue'], parser: tseslint.parser },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      // a new variant in a source-of-truth union must break every switch over it, including void switches;
      // a `default` does not count as handling the variants it would swallow
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: false, allowDefaultCaseForExhaustiveSwitch: false }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      '@typescript-eslint/no-invalid-void-type': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'vue/multi-word-component-names': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
  {
    files: ['**/*.test.ts', '**/typetests/**'],
    rules: { '@typescript-eslint/no-unused-expressions': 'off', '@typescript-eslint/require-await': 'off' },
  },
  {
    // tests define small stand-in components inline; their props are typed by the setup function's signature
    files: ['**/*.test.ts'],
    rules: { 'vue/one-component-per-file': 'off', 'vue/require-prop-types': 'off' },
  },
  {
    // the compile-time examples deliberately write mistakes under @ts-expect-error, and values used only as types
    files: ['**/typetests/**'],
    rules: {
      '@typescript-eslint/no-unsafe-call': 'off', '@typescript-eslint/no-meaningless-void-operator': 'off', '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-unnecessary-type-arguments': 'off', '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    // typescript-eslint cannot see the types of .vue modules from .ts files; vue-tsc checks this file
    files: ['packages/web/src/main.ts'],
    rules: { '@typescript-eslint/no-unsafe-argument': 'off' },
  },
  {
    // the same for the shared components a system page gets: each is a .vue module, and vue-tsc checks them against the SDK's props
    files: ['packages/web/src/system-pages/shared.ts'],
    rules: { '@typescript-eslint/no-unsafe-assignment': 'off' },
  },
);
