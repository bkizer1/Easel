module.exports = {
  root: true,
  env: {
    browser: true,
    es2021: true,
    node: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
    'prettier',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  rules: {
    'react/react-in-jsx-scope': 'off',
    'react/prop-types': 'off',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    // Electron's <webview> uses custom attributes React's DOM typings don't know.
    'react/no-unknown-property': [
      'error',
      { ignore: ['preload', 'partition', 'webpreferences', 'allowpopups', 'nodeintegration'] },
    ],
    // Deep type-aware linting is intentionally not enabled here — `tsc --strict`
    // (npm run typecheck) is the source of truth for type correctness. This keeps
    // ESLint fast and focused on style/correctness without a project-wide type pass.
  },
  settings: {
    react: {
      version: 'detect',
    },
  },
  // Config files are not part of the app's tsconfig; don't lint them.
  ignorePatterns: [
    'node_modules',
    'out',
    'dist',
    'build',
    '*.config.ts',
    '*.config.js',
    '*.config.mjs',
    'scripts/**',
    'examples/**',
  ],
};
