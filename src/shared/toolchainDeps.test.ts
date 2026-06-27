import { describe, it, expect } from 'vitest';
import {
  TEMPLATE_DEPENDENCIES,
  TEMPLATE_DEV_DEPENDENCIES,
  TOOLCHAIN_DEPENDENCIES,
} from './toolchainDeps';

describe('toolchain dependency manifest', () => {
  it('toolchain is a superset of every template dependency, at the same version', () => {
    const projectDeps = { ...TEMPLATE_DEPENDENCIES, ...TEMPLATE_DEV_DEPENDENCIES };
    const tc = TOOLCHAIN_DEPENDENCIES as Record<string, string>;
    for (const [name, version] of Object.entries(projectDeps)) {
      // If this fails, a project would import a package the shared toolchain
      // doesn't provide (or provides at a mismatched version) → broken preview.
      expect(tc[name], `toolchain must provide ${name}`).toBe(version);
    }
  });

  it('pins exact versions (no "latest"/"*") so the shared cache is deterministic', () => {
    for (const v of Object.values(TOOLCHAIN_DEPENDENCIES)) {
      expect(v).toMatch(/^\^?\d+\.\d+\.\d+$/);
    }
  });
});
