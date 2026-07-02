/**
 * Easel — lasso-refactor cluster detection (issue #15).
 *
 * When the user draws a freeform (lasso) region on the live preview, the guest
 * inspector resolves it to a ranked {@link ElementTarget}[]. This module groups
 * those targets by STRUCTURAL SIMILARITY and surfaces the clusters that span
 * multiple source files as candidates for "extract a reusable component".
 *
 * Pure logic, no side effects, no React, no DOM, no IPC. Safe to import from
 * any renderer module.
 */

import type { ElementTarget } from '@shared/types';

/* -------------------------------------------------------------------------- */
/*  Public types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A group of structurally-similar {@link ElementTarget}s that share a computed
 * signature. Cluster ids are stable (derived from the signature itself), so
 * repeated calls with the same targets produce identical ids.
 */
export interface SimilarityCluster {
  /** Stable id derived from the shared signature: `'cl-' + djb2(signature).toString(36)`. */
  id: string;
  /** All structurally-similar members, in their original input order. Length >= 2. */
  members: ElementTarget[];
  /** Distinct `dataEaselSource.filePath` values across members, first-seen order. */
  files: string[];
  /** The structural signature every member shares. */
  signature: string;
  /** PascalCase component-name guess (deterministic; see {@link deriveComponentName}). */
  suggestedName: string;
}

/* -------------------------------------------------------------------------- */
/*  Hashing (djb2 → base36, no external dependency)                          */
/* -------------------------------------------------------------------------- */

/**
 * Tiny deterministic djb2 hash of an ASCII/UTF-16 string. Returns a non-negative
 * 32-bit integer as a base-36 string for use as a short id suffix.
 */
function djb2Base36(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    // djb2: h = (h * 33) ^ charCode, kept in 32-bit signed range via |0
    h = (((h << 5) + h) ^ s.charCodeAt(i)) | 0;
  }
  // Convert to unsigned 32-bit, then to base36 to keep ids short
  return (h >>> 0).toString(36);
}

/* -------------------------------------------------------------------------- */
/*  Class normalisation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Patterns that identify auto-generated / hashed class tokens that vary between
 * instances of the same component and must therefore be DROPPED before comparing
 * structural signatures.
 *
 * - CSS-modules style hash suffix: `card_a1b2c3`
 * - styled-components / emotion style: `css-AbCd1234`, `sc-AbCd1234`
 * - Purely hex-ish blobs (length >= 8, at least one digit): `a1b2c3d4`
 *
 * The CSS-modules and pure-hash checks REQUIRE a digit in the suffix so that
 * legitimate snake_case class conventions (`product_card`, `hero_section`,
 * `nav_item`) are NOT mistaken for generated hashes and stripped — doing so
 * would collapse unrelated elements onto an empty signature and mis-cluster
 * them. CSS-modules suffixes are content hashes and effectively always contain
 * a digit, so the digit guard keeps real hashes (`card_a1b2c3`) dropped while
 * preserving human-authored names.
 */
const RE_CSS_MODULE_HASH = /_([A-Za-z0-9]{4,})$/; // suffix dropped only if it contains a digit
const RE_STYLED_HASH = /^(?:css|sc)-[A-Za-z0-9]{4,}$/;
const RE_PURE_HASH = /^[a-z0-9]{8,}$/; // matched only when at least one digit present

/** Return true when a class token looks like a generated / unstable hash. */
function isHashedToken(token: string): boolean {
  if (RE_STYLED_HASH.test(token)) return true;
  // CSS-modules suffix: `name_<hash>`, but only when the suffix has a digit so
  // human-authored snake_case (`product_card`) is preserved.
  const cssModule = RE_CSS_MODULE_HASH.exec(token);
  if (cssModule && /[0-9]/.test(cssModule[1])) return true;
  // Pure hex-ish: all lowercase alphanumeric, >= 8 chars, and contains a digit
  if (RE_PURE_HASH.test(token) && /[0-9]/.test(token)) return true;
  return false;
}

/**
 * Produce the normalised, sorted class list for `attributes.class`.
 * Returns an empty array when no class attribute is present.
 */
function normalizeClasses(attributes: Record<string, string>): string[] {
  const raw = attributes['class'] ?? '';
  return raw
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !isHashedToken(t))
    .sort();
}

/* -------------------------------------------------------------------------- */
/*  Structural signature                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Compute the structural signature for a target:
 * `<tagName>|<normalizedClasses.join('.')>`
 */
function computeSignature(target: ElementTarget): string {
  const classes = normalizeClasses(target.attributes);
  return `${target.tagName}|${classes.join('.')}`;
}

/* -------------------------------------------------------------------------- */
/*  Suggested component name                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Convert a hyphen/underscore/non-alphanumeric-separated string to PascalCase.
 * Examples: `product-card` → `ProductCard`, `hero_section` → `HeroSection`.
 */
function toPascalCase(s: string): string {
  return s
    .split(/[-_\W]+/)
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/**
 * Strip any leading characters that would make the result an invalid JS
 * identifier start (digits and other non-alpha, non-underscore, non-dollar).
 */
function ensureValidIdentifier(name: string): string {
  return name.replace(/^[^A-Za-z_$]+/, '');
}

/**
 * Derive a deterministic PascalCase component-name guess for a cluster.
 *
 * Priority:
 * 1. Longest surviving (non-hashed) class token; ties broken alphabetically.
 * 2. Basename-without-extension of the first member's source file.
 * 3. PascalCase(tagName) + 'Component'.
 *
 * The result is always a non-empty, valid JS identifier.
 */
function deriveComponentName(
  normalizedClasses: string[],
  tagName: string,
  firstFilePath?: string,
): string {
  // 1. Longest surviving class token (tie → first alphabetically after sort)
  if (normalizedClasses.length > 0) {
    const best = [...normalizedClasses].sort((a, b) => {
      if (b.length !== a.length) return b.length - a.length;
      return a.localeCompare(b);
    })[0];
    const name = ensureValidIdentifier(toPascalCase(best));
    if (name.length > 0) return name;
  }

  // 2. File basename without extension
  if (firstFilePath) {
    // e.g. 'src/ui/Hero.tsx' → 'Hero'
    const base = firstFilePath.split('/').pop() ?? '';
    const noExt = base.replace(/\.[^.]+$/, '');
    if (noExt.length > 0) {
      const name = ensureValidIdentifier(toPascalCase(noExt));
      if (name.length > 0) return name;
    }
  }

  // 3. Fallback: PascalCase(tagName) + 'Component'
  return toPascalCase(tagName) + 'Component';
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Group `targets` by structural signature and return clusters with >= 2 members,
 * ordered by `members.length` descending (stable for ties, preserving input order
 * within each cluster).
 *
 * Targets that lack `dataEaselSource` are excluded from all clusters because they
 * cannot be rewritten by the agent (no source location).
 */
export function detectClusters(targets: ElementTarget[]): SimilarityCluster[] {
  // Phase 1: collect eligible targets (those with a known source location)
  const eligible = targets.filter((t) => t.dataEaselSource !== undefined);

  // Phase 2: group by structural signature, preserving input order within each group
  const groups = new Map<string, ElementTarget[]>();
  for (const target of eligible) {
    const sig = computeSignature(target);
    let group = groups.get(sig);
    if (!group) {
      group = [];
      groups.set(sig, group);
    }
    group.push(target);
  }

  // Phase 3: build SimilarityCluster for groups with >= 2 members
  const clusters: SimilarityCluster[] = [];
  for (const [signature, members] of groups) {
    if (members.length < 2) continue;

    // Distinct file paths in first-seen order
    const filesSeen = new Set<string>();
    const files: string[] = [];
    for (const m of members) {
      const fp = m.dataEaselSource!.filePath;
      if (!filesSeen.has(fp)) {
        filesSeen.add(fp);
        files.push(fp);
      }
    }

    // Derive the component name from the shared normalised classes of the first member
    const normalizedClasses = normalizeClasses(members[0].attributes);
    const suggestedName = deriveComponentName(normalizedClasses, members[0].tagName, files[0]);

    clusters.push({
      id: `cl-${djb2Base36(signature)}`,
      members,
      files,
      signature,
      suggestedName,
    });
  }

  // Phase 4: stable sort by members.length descending
  // Array.prototype.sort is stable in V8 (ES2019+), so ties preserve insertion order
  clusters.sort((a, b) => b.members.length - a.members.length);

  return clusters;
}

/**
 * Return true when a cluster is worth offering "extract a reusable component":
 * it must have >= 2 members AND span >= 2 distinct source files.
 */
export function isExtractable(cluster: SimilarityCluster): boolean {
  return cluster.members.length >= 2 && cluster.files.length >= 2;
}

/**
 * Convenience wrapper: detect all clusters then keep only the extractable ones.
 * Equivalent to `detectClusters(targets).filter(isExtractable)`.
 */
export function extractableClusters(targets: ElementTarget[]): SimilarityCluster[] {
  return detectClusters(targets).filter(isExtractable);
}
