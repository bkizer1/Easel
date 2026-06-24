/**
 * Easel Vite Plugin: Inspector
 *
 * This plugin instruments JSX/HTML elements with source location metadata
 * (data-easel-source="file:line:col") during Vite dev builds, enabling Easel's
 * agent to map visual elements to their source code with high confidence.
 *
 * Full implementation spec: docs/ELEMENT_SOURCE_MAPPING.md
 * Fallback path (when plugin is absent): grepping source + CSS selectors
 */

import type { Plugin, ResolvedConfig } from 'vite';
import { transformSource } from './transform.js';

export interface InspectorOptions {
  /** Only instrument dev builds (default: true). Reduces bundle size in prod. */
  dev?: boolean;
  /** HTML attribute name for source metadata (default: 'data-easel-source'). */
  attributeName?: string;
  /** Debug logging (default: false). */
  debug?: boolean;
}

/**
 * Vite plugin that stamps DOM elements with source location data.
 *
 * - Dev-only: guarded by `configResolved(command === 'serve')`
 * - Targets .jsx/.tsx files (and optionally .vue/.svelte in future)
 * - Injects `data-easel-source="relativeFile:line:col"` on JSX opening elements
 * - Preserves idempotency: skips elements already stamped
 * - Passes source maps through to enable HMR
 *
 * @param options Configuration options
 * @returns A Vite plugin
 */
export function easelInspector(options: InspectorOptions = {}): Plugin {
  const { attributeName = 'data-easel-source', debug = false } = options;
  let isDev = false;
  let projectRoot = '';

  return {
    name: '@easel/vite-plugin-inspector',

    /**
     * Store the config at resolution time; guard by command === 'serve'.
     */
    configResolved(config: ResolvedConfig) {
      isDev = config.command === 'serve';
      projectRoot = config.root;
      if (debug && isDev) {
        console.log(`[easel-inspector] initialized for dev mode, root: ${projectRoot}`);
      }
    },

    /**
     * Transform .jsx/.tsx files: inject data-easel-source attributes.
     *
     * @param code Source code
     * @param id Vite module ID (absolute file path)
     * @returns Transformed code and source map, or null if unchanged
     */
    transform(code: string, id: string) {
      // Skip if not in dev mode
      if (!isDev) {
        return null;
      }

      // Only process JSX/TSX files for now. Vue/Svelte/HTML are post-MVP.
      if (!/\.[jt]sx?$/.test(id)) {
        return null;
      }

      if (debug) {
        console.log(`[easel-inspector] transforming ${id}`);
      }

      // Perform the AST transformation
      const result = transformSource(code, id, projectRoot, attributeName);

      // transformSource returns null on parse error; let framework plugins handle it
      return result;
    },
  };
}

// Also export as default for ESM compatibility
export default easelInspector;

/**
 * Export types for consumer configuration.
 */
export type { InspectorOptions };
