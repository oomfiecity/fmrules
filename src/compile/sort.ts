/**
 * Assign sortOrder to every rule, producing the top-to-bottom execution
 * order Fastmail uses at runtime.
 *
 * Scheme:
 *   - Files listed in meta/config.yaml `file_order` get base offsets
 *     `index * 10_000`. Unlisted files follow, alphabetically, at bases
 *     `(listedCount + alphaIndex) * 10_000`.
 *   - Within a file, rule N (from the source YAML) gets base offset
 *     `N * 100`. Spacing of 100 leaves room for fan-out siblings.
 *   - Fan-out children add `fanoutIndex` (0..N-1) to their parent's
 *     base, so they cluster adjacent to the source rule's position.
 *   - Explicit `sort_order:` on a rule overrides everything.
 */

import type { ConfigYaml } from '../schema/yaml.ts';
import type { PartialRule } from '../types.ts';
import type { LoadedFile } from './load.ts';

const FILE_STRIDE = 10_000;
const RULE_STRIDE = 100;

export function assignSortOrder(
  rules: PartialRule[],
  files: LoadedFile[],
  config: ConfigYaml,
): void {
  const fileBase = computeFileBases(files, config);
  for (const rule of rules) {
    if (rule.sortOrder !== undefined) continue; // explicit override
    const base = fileBase.get(rule.meta.file);
    if (base === undefined) {
      throw new Error(
        `Internal: no sort base for file ${rule.meta.file} (rule "${rule.name}")`,
      );
    }
    rule.sortOrder = base + rule.meta.fileIndex * RULE_STRIDE + rule.meta.fanoutIndex;
  }
  rules.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

/**
 * After a module pass, re-assign `fanoutIndex` so siblings produced from
 * the same parent stay adjacent under the parent's sort-order base. Lives
 * beside the sort formula (`assignSortOrder` above) — fanoutIndex is only
 * meaningful as an input to that formula.
 */
export function stampFanoutIndices(rules: PartialRule[], parent: PartialRule): PartialRule[] {
  if (rules.length === 1) return rules;
  return rules.map((r, i) => ({
    ...r,
    meta: {
      ...r.meta,
      file: parent.meta.file,
      fileIndex: parent.meta.fileIndex,
      fanoutIndex: i,
    },
  }));
}

function computeFileBases(files: LoadedFile[], config: ConfigYaml): Map<string, number> {
  const names = files.map((f) => f.name);
  const ordered = config.file_order ?? [];
  const result = new Map<string, number>();
  let next = 0;
  for (const listed of ordered) {
    if (names.includes(listed)) {
      result.set(listed, next * FILE_STRIDE);
      next++;
    }
  }
  const remaining = names.filter((n) => !result.has(n)).sort();
  for (const name of remaining) {
    result.set(name, next * FILE_STRIDE);
    next++;
  }
  return result;
}
