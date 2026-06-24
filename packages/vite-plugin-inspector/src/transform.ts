/**
 * AST transformation logic for @easel/vite-plugin-inspector.
 *
 * Uses Babel (@babel/parser + @babel/traverse + @babel/generator) to:
 * 1. Parse JSX/TSX code into an AST
 * 2. Walk the tree to find JSXOpeningElement nodes
 * 3. For each element, inject a data-easel-source attribute with file:line:col
 * 4. Preserve source maps for HMR
 *
 * This module is pure and unit-testable; it does not touch the filesystem.
 */

import * as t from '@babel/types';
import traverse from '@babel/traverse';
import { parse } from '@babel/parser';
import generate from '@babel/generator';
import path from 'node:path';

/**
 * Result of a source transformation.
 */
export interface TransformResult {
  code: string;
  // Babel sourcemap object, passed through to Vite; its shape varies by version.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  map: any;
}

/**
 * Transform JSX/TSX source by injecting data-easel-source attributes.
 *
 * @param code The source code to transform
 * @param absoluteId The absolute file path (as provided by Vite's transform hook)
 * @param projectRoot The project root directory (from Vite config)
 * @param attributeName The attribute name to inject (default: 'data-easel-source')
 * @returns Transformed code and source map, or null if parse failed
 */
export function transformSource(
  code: string,
  absoluteId: string,
  projectRoot: string,
  attributeName: string = 'data-easel-source',
): TransformResult | null {
  // Compute relative path from project root to the current module
  const relativeId = path.relative(projectRoot, absoluteId);

  // Parse the source into an AST
  let ast: t.File;
  try {
    ast = parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
      sourceFilename: absoluteId,
    });
  } catch {
    // Parse failure; let the framework plugin (React, etc.) report the error
    return null;
  }

  // Track whether we made any modifications
  let modified = false;

  // Walk the AST and instrument JSX opening elements
  traverse(ast, {
    JSXOpeningElement(nodePath) {
      const { node } = nodePath;
      const loc = node.loc?.start;

      // Skip if no location information (shouldn't happen with proper parser config)
      if (!loc) {
        return;
      }

      // Check if this element is already stamped (idempotency guard for HMR)
      const alreadyStamped = node.attributes.some(
        (attr) =>
          t.isJSXAttribute(attr) &&
          t.isJSXIdentifier(attr.name, { name: attributeName }),
      );

      if (alreadyStamped) {
        return;
      }

      // Construct the attribute value: "relativeFile:line:col"
      // Babel provides 1-based line numbers. Column is 0-based, so we add 1 for consistency.
      const value = `${relativeId}:${loc.line}:${loc.column + 1}`;

      // Create the JSX attribute node
      const attr = t.jsxAttribute(
        t.jsxIdentifier(attributeName),
        t.stringLiteral(value),
      );

      // Prepend the attribute so it appears first in the final DOM (for readability)
      node.attributes.unshift(attr);

      modified = true;
    },
  });

  // If no elements were instrumented, return null (no transformation)
  if (!modified) {
    return null;
  }

  // Generate the transformed code with source maps
  const { code: transformedCode, map } = generate(
    ast,
    {
      sourceMaps: true,
      sourceFileName: absoluteId,
    },
    code,
  );

  return {
    code: transformedCode,
    map,
  };
}
