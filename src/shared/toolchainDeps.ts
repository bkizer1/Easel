/**
 * Easel — shared toolchain dependency manifest (single source of truth).
 *
 * New sites are created as plain source + a symlink to ONE shared toolchain that
 * Easel maintains in `userData` (see `src/main/toolchain.ts`), instead of running
 * a per-project `npm install`. For that to work, the toolchain must provide every
 * package a scaffolded project imports. These constants are the one place those
 * version sets are declared; `toolchainDeps.test.ts` enforces that the toolchain
 * is a superset of the template, so the two can never drift apart.
 *
 * Pure module (no Electron / fs) so it's safe to import from both main and tests.
 */

/** Runtime deps written into a scaffolded project's package.json. */
export const TEMPLATE_DEPENDENCIES = {
  react: '^18.3.1',
  'react-dom': '^18.3.1',
} as const;

/** Dev deps written into a scaffolded project's package.json. */
export const TEMPLATE_DEV_DEPENDENCIES = {
  '@vitejs/plugin-react': '^4.3.1',
  typescript: '^5.5.4',
  vite: '^5.3.4',
} as const;

/**
 * Everything the shared toolchain installs. Must be a superset of the template's
 * deps (enforced by test) so a project's symlinked `node_modules` resolves every
 * import. The project's own package.json still declares its real deps, so it
 * stays a standard, standalone-installable project.
 */
export const TOOLCHAIN_DEPENDENCIES = {
  ...TEMPLATE_DEPENDENCIES,
  ...TEMPLATE_DEV_DEPENDENCIES,
} as const;
