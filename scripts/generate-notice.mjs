#!/usr/bin/env node

/**
 * Generate a NOTICE file aggregating third-party licenses.
 *
 * This script scans node_modules for package.json files, extracts license info,
 * and generates a human-readable NOTICE file listing all third-party dependencies
 * used by Easel. The output respects the format:
 *   - Component Name
 *   - Version
 *   - License
 *   - Repository URL (if available)
 *
 * Output: NOTICE (plaintext)
 *
 * Usage:
 *   node scripts/generate-notice.mjs
 *   npm run notice
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = path.join(__dirname, '..');
const nodeModulesPath = path.join(projectRoot, 'node_modules');
const noticeFile = path.join(projectRoot, 'NOTICE');

const NOTICE_HEADER = `# NOTICE

This file contains attribution notices for third-party software included in Easel.
Generated at build time from package.json files in node_modules.

Each entry below includes:
  - Component Name
  - Version
  - License
  - Repository URL (if available)

===

`;

/**
 * Extract license from a package.json object.
 */
function getLicense(pkg) {
  if (typeof pkg.license === 'string') {
    return pkg.license;
  }
  if (Array.isArray(pkg.license)) {
    return pkg.license.join(', ');
  }
  if (typeof pkg.licenses === 'object' && Array.isArray(pkg.licenses)) {
    return pkg.licenses.map((l) => (typeof l === 'string' ? l : l.type)).join(', ');
  }
  return 'Unlicensed';
}

/**
 * Extract repository URL from a package.json object.
 */
function getRepository(pkg) {
  if (typeof pkg.repository === 'string') {
    return pkg.repository;
  }
  if (typeof pkg.repository === 'object' && pkg.repository.url) {
    return pkg.repository.url;
  }
  return null;
}

/**
 * Scan node_modules and collect all top-level packages.
 */
function scanNodeModules() {
  const packages = [];

  if (!fs.existsSync(nodeModulesPath)) {
    console.warn(`node_modules not found at ${nodeModulesPath}`);
    return packages;
  }

  const entries = fs.readdirSync(nodeModulesPath, { withFileTypes: true });

  for (const entry of entries) {
    // Skip hidden files and non-directories
    if (entry.name.startsWith('.') || !entry.isDirectory()) {
      continue;
    }

    // Handle @scoped packages
    if (entry.name.startsWith('@')) {
      const scopePath = path.join(nodeModulesPath, entry.name);
      const scopedEntries = fs.readdirSync(scopePath, { withFileTypes: true });
      for (const scopedEntry of scopedEntries) {
        if (!scopedEntry.isDirectory()) continue;
        const pkgName = `${entry.name}/${scopedEntry.name}`;
        const pkgJsonPath = path.join(scopePath, scopedEntry.name, 'package.json');
        if (fs.existsSync(pkgJsonPath)) {
          packages.push({ name: pkgName, path: pkgJsonPath });
        }
      }
    } else {
      const pkgJsonPath = path.join(nodeModulesPath, entry.name, 'package.json');
      if (fs.existsSync(pkgJsonPath)) {
        packages.push({ name: entry.name, path: pkgJsonPath });
      }
    }
  }

  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build the notice content from scanned packages.
 */
function buildNoticeContent() {
  let content = NOTICE_HEADER;
  const packages = scanNodeModules();

  if (packages.length === 0) {
    content += 'No third-party packages found in node_modules.\n';
    return content;
  }

  for (const { name, path: pkgPath } of packages) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const version = pkg.version || 'unknown';
      const license = getLicense(pkg);
      const repo = getRepository(pkg);

      content += `${name} (${version})\n`;
      content += `  License: ${license}\n`;
      if (repo) {
        // Clean up git+https:// style URLs
        const repoUrl = repo.replace(/^git\+/, '').replace(/\.git$/, '');
        content += `  Repository: ${repoUrl}\n`;
      }
      content += '\n';
    } catch (err) {
      console.warn(`Warning: Failed to read ${pkgPath}: ${err.message}`);
    }
  }

  return content;
}

/**
 * Main: generate the NOTICE file.
 */
try {
  const content = buildNoticeContent();
  fs.writeFileSync(noticeFile, content, 'utf-8');
  console.log(`✓ NOTICE file generated successfully: ${noticeFile}`);
  process.exit(0);
} catch (err) {
  console.error(`✗ Failed to generate NOTICE: ${err.message}`);
  process.exit(1);
}
