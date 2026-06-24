#!/usr/bin/env node

/**
 * Generate a CycloneDX SBOM (Software Bill of Materials) for Easel.
 *
 * This script uses @cyclonedx/cyclonedx-npm to create a comprehensive
 * inventory of all project dependencies, including transitive dependencies,
 * licenses, and vulnerability data.
 *
 * Output: sbom.cdx.json (CycloneDX 1.4 JSON format)
 *
 * Usage:
 *   node scripts/generate-sbom.mjs
 *   npm run sbom
 */

import { execSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..');
const outputFile = join(projectRoot, 'sbom.cdx.json');

console.log('Generating CycloneDX SBOM for Easel...');

try {
  // Run cyclonedx-npm with sensible defaults for Electron apps.
  // --output-file: write to sbom.cdx.json
  // --spec-version: use 1.4 (latest stable)
  // --shallow: include direct dependencies; set to false to include transitive
  const command = [
    'npx @cyclonedx/cyclonedx-npm@latest',
    '--output-file', outputFile,
    '--spec-version', '1.4',
  ].join(' ');

  console.log(`Running: ${command}`);
  execSync(command, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, CI: 'true' },
  });

  if (existsSync(outputFile)) {
    const stat = statSync(outputFile);
    console.log(`✓ SBOM generated successfully: ${outputFile} (${stat.size} bytes)`);
    process.exit(0);
  } else {
    console.error('✗ SBOM file was not created');
    process.exit(1);
  }
} catch (error) {
  console.error('✗ Failed to generate SBOM:', error.message);
  process.exit(1);
}
