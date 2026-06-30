/**
 * Easel — unit tests for refactorClusters (issue #15).
 */

import { describe, it, expect } from 'vitest';
import type { ElementTarget } from '@shared/types';
import { detectClusters, isExtractable, extractableClusters } from './refactorClusters';

/* -------------------------------------------------------------------------- */
/*  Test factory                                                               */
/* -------------------------------------------------------------------------- */

let _seq = 0;

/**
 * Build a minimal, valid ElementTarget. Sane defaults for every required field
 * so individual tests only specify what they care about.
 */
function mk(partial: Partial<ElementTarget> & { id?: string }): ElementTarget {
  const id = partial.id ?? `t${++_seq}`;
  return {
    id,
    selector: `[data-testid="${id}"]`,
    tagName: 'div',
    boundingBox: { x: 0, y: 0, width: 100, height: 100 },
    textSnippet: '',
    attributes: {},
    pluginPresent: true,
    confidence: 'high',
    ...partial,
  };
}

/* -------------------------------------------------------------------------- */
/*  1. Basic extractable cluster                                               */
/* -------------------------------------------------------------------------- */

describe('detectClusters — basic extractable cluster', () => {
  it('two <article class="product-card"> in different files → one extractable cluster', () => {
    const targets = [
      mk({
        tagName: 'article',
        attributes: { class: 'product-card' },
        dataEaselSource: { filePath: 'src/pages/Home.tsx', line: 10, column: 1 },
      }),
      mk({
        tagName: 'article',
        attributes: { class: 'product-card' },
        dataEaselSource: { filePath: 'src/pages/Shop.tsx', line: 20, column: 1 },
      }),
    ];

    const clusters = detectClusters(targets);
    expect(clusters).toHaveLength(1);

    const [c] = clusters;
    expect(c.members).toHaveLength(2);
    expect(c.files).toHaveLength(2);
    expect(c.files).toContain('src/pages/Home.tsx');
    expect(c.files).toContain('src/pages/Shop.tsx');
    expect(c.suggestedName).toBe('ProductCard');
    expect(isExtractable(c)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  2. Hashed classes are dropped before comparison                           */
/* -------------------------------------------------------------------------- */

describe('detectClusters — hashed class normalisation', () => {
  it('hash-suffixed classes dropped, elements still cluster by stable class', () => {
    const targets = [
      mk({
        tagName: 'div',
        attributes: { class: 'product-card card_a1b2c3' },
        dataEaselSource: { filePath: 'src/A.tsx', line: 1, column: 1 },
      }),
      mk({
        tagName: 'div',
        attributes: { class: 'product-card card_d4e5f6' },
        dataEaselSource: { filePath: 'src/B.tsx', line: 1, column: 1 },
      }),
    ];

    const clusters = detectClusters(targets);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toHaveLength(2);
    // Only the stable class token survives in the signature
    expect(clusters[0].signature).toBe('div|product-card');
    expect(clusters[0].suggestedName).toBe('ProductCard');
  });

  it('styled-components css- prefix is also dropped', () => {
    const targets = [
      mk({
        tagName: 'span',
        attributes: { class: 'badge css-AbCd1234' },
        dataEaselSource: { filePath: 'src/X.tsx', line: 1, column: 1 },
      }),
      mk({
        tagName: 'span',
        attributes: { class: 'badge css-ZzZz9999' },
        dataEaselSource: { filePath: 'src/Y.tsx', line: 1, column: 1 },
      }),
    ];

    const clusters = detectClusters(targets);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].signature).toBe('span|badge');
  });

  it('legitimate snake_case classes (no digit in suffix) are PRESERVED, not treated as hashes', () => {
    // Regression: a `name_word` class with no digit must survive normalisation,
    // otherwise unrelated elements collapse onto an empty signature and mis-cluster.
    const targets = [
      mk({
        tagName: 'div',
        attributes: { class: 'product_card' },
        dataEaselSource: { filePath: 'src/A.tsx', line: 1, column: 1 },
      }),
      mk({
        tagName: 'div',
        attributes: { class: 'product_card' },
        dataEaselSource: { filePath: 'src/B.tsx', line: 1, column: 1 },
      }),
      // A structurally UNRELATED snake_case element — must NOT join the cluster.
      mk({
        tagName: 'div',
        attributes: { class: 'hero_section' },
        dataEaselSource: { filePath: 'src/C.tsx', line: 1, column: 1 },
      }),
    ];

    const clusters = detectClusters(targets);
    // product_card (x2) clusters; hero_section (x1) does not form a cluster.
    expect(clusters).toHaveLength(1);
    expect(clusters[0].signature).toBe('div|product_card');
    expect(clusters[0].members).toHaveLength(2);
    expect(clusters[0].suggestedName).toBe('ProductCard');
  });

  it('pure hex-ish tokens (>= 8 chars with digit) are dropped', () => {
    const targets = [
      mk({
        tagName: 'section',
        attributes: { class: 'hero a1b2c3d4' },
        dataEaselSource: { filePath: 'src/P.tsx', line: 1, column: 1 },
      }),
      mk({
        tagName: 'section',
        attributes: { class: 'hero e5f6g7h8' },
        dataEaselSource: { filePath: 'src/Q.tsx', line: 1, column: 1 },
      }),
    ];

    const clusters = detectClusters(targets);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].signature).toBe('section|hero');
  });
});

/* -------------------------------------------------------------------------- */
/*  3. Same file → cluster exists but NOT extractable                         */
/* -------------------------------------------------------------------------- */

describe('isExtractable — same single source file', () => {
  it('two identical elements in one file → cluster in detectClusters but not extractable', () => {
    const targets = [
      mk({
        tagName: 'li',
        attributes: { class: 'nav-item' },
        dataEaselSource: { filePath: 'src/Nav.tsx', line: 5, column: 1 },
      }),
      mk({
        tagName: 'li',
        attributes: { class: 'nav-item' },
        dataEaselSource: { filePath: 'src/Nav.tsx', line: 10, column: 1 },
      }),
    ];

    const clusters = detectClusters(targets);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toHaveLength(2);
    expect(clusters[0].files).toHaveLength(1);
    expect(isExtractable(clusters[0])).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  4. Targets without dataEaselSource excluded                               */
/* -------------------------------------------------------------------------- */

describe('detectClusters — targets without dataEaselSource', () => {
  it('targets missing dataEaselSource are excluded from clusters', () => {
    const targets = [
      mk({
        tagName: 'article',
        attributes: { class: 'card' },
        // no dataEaselSource
      }),
      mk({
        tagName: 'article',
        attributes: { class: 'card' },
        dataEaselSource: { filePath: 'src/A.tsx', line: 1, column: 1 },
      }),
      mk({
        tagName: 'article',
        attributes: { class: 'card' },
        dataEaselSource: { filePath: 'src/B.tsx', line: 1, column: 1 },
      }),
    ];

    const clusters = detectClusters(targets);
    // Only the two targets WITH dataEaselSource should cluster
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toHaveLength(2);
    // The ineligible target must not appear as a member
    for (const m of clusters[0].members) {
      expect(m.dataEaselSource).toBeDefined();
    }
  });

  it('two targets with same signature but both missing dataEaselSource → no cluster', () => {
    const targets = [
      mk({ tagName: 'div', attributes: { class: 'box' } }),
      mk({ tagName: 'div', attributes: { class: 'box' } }),
    ];
    expect(detectClusters(targets)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  5. Different tagName or different real classes → distinct clusters         */
/* -------------------------------------------------------------------------- */

describe('detectClusters — structural divergence', () => {
  it('different tagName produces separate clusters', () => {
    const file = (n: string) => ({ filePath: `src/${n}.tsx`, line: 1, column: 1 });
    const targets = [
      mk({ tagName: 'div', attributes: { class: 'card' }, dataEaselSource: file('A') }),
      mk({ tagName: 'article', attributes: { class: 'card' }, dataEaselSource: file('B') }),
    ];
    // Each is a group of 1, so NO cluster at all (< 2 members)
    expect(detectClusters(targets)).toHaveLength(0);
  });

  it('same tagName but different real class sets produce separate signatures', () => {
    const file = (n: string) => ({ filePath: `src/${n}.tsx`, line: 1, column: 1 });
    const targets = [
      mk({ tagName: 'div', attributes: { class: 'card' }, dataEaselSource: file('A') }),
      mk({ tagName: 'div', attributes: { class: 'card' }, dataEaselSource: file('B') }),
      mk({ tagName: 'div', attributes: { class: 'panel' }, dataEaselSource: file('C') }),
      mk({ tagName: 'div', attributes: { class: 'panel' }, dataEaselSource: file('D') }),
    ];
    const clusters = detectClusters(targets);
    expect(clusters).toHaveLength(2);
    const sigs = clusters.map((c) => c.signature).sort();
    expect(sigs).toEqual(['div|card', 'div|panel']);
  });
});

/* -------------------------------------------------------------------------- */
/*  6. suggestedName fallbacks                                                 */
/* -------------------------------------------------------------------------- */

describe('suggestedName fallback logic', () => {
  it('no surviving classes → use file basename without extension', () => {
    const targets = [
      mk({
        tagName: 'header',
        attributes: {},
        dataEaselSource: { filePath: 'src/ui/Hero.tsx', line: 1, column: 1 },
      }),
      mk({
        tagName: 'header',
        attributes: {},
        dataEaselSource: { filePath: 'src/ui/Hero.tsx', line: 20, column: 1 },
      }),
    ];
    const clusters = detectClusters(targets);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].suggestedName).toBe('Hero');
  });

  it('no classes and no usable file path → PascalCase(tagName)+Component', () => {
    const targets = [
      mk({
        tagName: 'div',
        attributes: {},
        dataEaselSource: { filePath: 'index', line: 1, column: 1 },
      }),
      mk({
        tagName: 'div',
        attributes: {},
        dataEaselSource: { filePath: 'index', line: 5, column: 1 },
      }),
    ];
    // 'index' → toPascalCase('index') → 'Index', which IS usable, so we get 'Index'
    // To trigger the final fallback we need a truly empty basename
    const clusters = detectClusters(targets);
    // 'index' basename is non-empty, so suggestedName = 'Index'
    expect(clusters[0].suggestedName).toBe('Index');
  });

  it('tagName fallback used when file path has no basename', () => {
    // Synthesise targets with an empty filePath to exercise the final fallback
    const targets = [
      mk({
        tagName: 'section',
        attributes: {},
        dataEaselSource: { filePath: '', line: 1, column: 1 },
      }),
      mk({
        tagName: 'section',
        attributes: {},
        dataEaselSource: { filePath: '', line: 2, column: 1 },
      }),
    ];
    const clusters = detectClusters(targets);
    expect(clusters[0].suggestedName).toBe('SectionComponent');
  });
});

/* -------------------------------------------------------------------------- */
/*  7. Ordering: larger clusters first                                         */
/* -------------------------------------------------------------------------- */

describe('detectClusters — ordering', () => {
  it('3-member cluster sorts before 2-member cluster', () => {
    const file = (n: string) => ({ filePath: `src/${n}.tsx`, line: 1, column: 1 });
    const targets = [
      // Two-member cluster: "panel"
      mk({ tagName: 'div', attributes: { class: 'panel' }, dataEaselSource: file('A') }),
      mk({ tagName: 'div', attributes: { class: 'panel' }, dataEaselSource: file('B') }),
      // Three-member cluster: "card"
      mk({ tagName: 'div', attributes: { class: 'card' }, dataEaselSource: file('C') }),
      mk({ tagName: 'div', attributes: { class: 'card' }, dataEaselSource: file('D') }),
      mk({ tagName: 'div', attributes: { class: 'card' }, dataEaselSource: file('E') }),
    ];

    const clusters = detectClusters(targets);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].members).toHaveLength(3);
    expect(clusters[0].signature).toBe('div|card');
    expect(clusters[1].members).toHaveLength(2);
    expect(clusters[1].signature).toBe('div|panel');
  });
});

/* -------------------------------------------------------------------------- */
/*  8. extractableClusters convenience function                               */
/* -------------------------------------------------------------------------- */

describe('extractableClusters', () => {
  it('filters out same-file clusters, keeps multi-file ones', () => {
    const targets = [
      // Same-file cluster (not extractable)
      mk({
        tagName: 'li',
        attributes: { class: 'item' },
        dataEaselSource: { filePath: 'src/List.tsx', line: 1, column: 1 },
      }),
      mk({
        tagName: 'li',
        attributes: { class: 'item' },
        dataEaselSource: { filePath: 'src/List.tsx', line: 5, column: 1 },
      }),
      // Multi-file cluster (extractable)
      mk({
        tagName: 'article',
        attributes: { class: 'card' },
        dataEaselSource: { filePath: 'src/Home.tsx', line: 1, column: 1 },
      }),
      mk({
        tagName: 'article',
        attributes: { class: 'card' },
        dataEaselSource: { filePath: 'src/Shop.tsx', line: 1, column: 1 },
      }),
    ];

    const result = extractableClusters(targets);
    expect(result).toHaveLength(1);
    expect(result[0].signature).toBe('article|card');
    expect(result[0].files).toHaveLength(2);
  });

  it('returns empty array when no extractable clusters exist', () => {
    const targets = [
      mk({
        tagName: 'div',
        attributes: { class: 'box' },
        dataEaselSource: { filePath: 'src/Only.tsx', line: 1, column: 1 },
      }),
      mk({
        tagName: 'div',
        attributes: { class: 'box' },
        dataEaselSource: { filePath: 'src/Only.tsx', line: 2, column: 1 },
      }),
    ];
    expect(extractableClusters(targets)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Bonus: cluster id is stable and prefixed with 'cl-'                       */
/* -------------------------------------------------------------------------- */

describe('cluster id stability', () => {
  it('ids are prefixed with "cl-" and identical across two calls with same signature', () => {
    const makeTargets = () => [
      mk({
        tagName: 'button',
        attributes: { class: 'btn-primary' },
        dataEaselSource: { filePath: 'src/A.tsx', line: 1, column: 1 },
      }),
      mk({
        tagName: 'button',
        attributes: { class: 'btn-primary' },
        dataEaselSource: { filePath: 'src/B.tsx', line: 1, column: 1 },
      }),
    ];

    const [c1] = detectClusters(makeTargets());
    const [c2] = detectClusters(makeTargets());

    expect(c1.id).toMatch(/^cl-/);
    expect(c1.id).toBe(c2.id);
  });
});
