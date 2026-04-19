/**
 * Turn a raw YAML rule entry into a PartialRule by:
 *   1. Resolving its referenced archetype (if any) against the file's archetypes.
 *   2. Merging file defaults + archetype + rule body (in that order).
 *   3. Lowering snake_case keys to camelCase for internal use.
 *   4. Resolving the module chain (concatenate layers, dedup by name+args, handle `-name` subtract).
 *
 * Does NOT build the search tree yet — that happens after modules run.
 */

import type { ArchetypeYaml, FileDefaultsYaml, ModuleRefYaml, RuleYaml } from '../schema/yaml.ts';
import { FIELDS, type FieldKind, type FieldSpec } from '../schema/fields.ts';
import type { Actions, Matchers, ModuleRef, PartialRule, SourceMeta } from '../types.ts';

/**
 * Convert a single YAML value to its internal form for a given field shape.
 * Only `stringOrList` needs normalization (scalar → array). Every other
 * shape passes through untouched; their internal representation matches
 * their parsed YAML representation.
 */
function convertValue(value: unknown, f: FieldSpec): unknown {
  if (f.shape === 'stringOrList' && value !== null) {
    return Array.isArray(value) ? value : [value];
  }
  return value;
}

function pick<T extends object>(src: object, kind: FieldKind): T {
  const rec = src as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) {
    if (f.kind !== kind) continue;
    const v = rec[f.yaml];
    if (v === undefined) continue;
    out[f.internal] = convertValue(v, f);
  }
  return out as T;
}

const pickMatchers = (src: object): Matchers => pick<Matchers>(src, 'matcher');
const pickActions = (src: object): Actions => pick<Actions>(src, 'action');

function mergeMatchers(...layers: Matchers[]): Matchers {
  const out: Matchers = {};
  for (const layer of layers) Object.assign(out, layer);
  return out;
}

function mergeActions(...layers: Actions[]): Actions {
  const out: Actions = {};
  for (const layer of layers) Object.assign(out, layer);
  return out;
}

function refAsObject(ref: ModuleRefYaml): ModuleRef {
  return typeof ref === 'string' ? { name: ref } : { name: ref.name, args: ref.args };
}

function argsKey(args: unknown): string {
  if (args === undefined) return '';
  return JSON.stringify(args);
}

/**
 * Walk module chains from defaults → archetype → rule body in order,
 * maintaining the kept list as we go:
 *   - `-name` removes prior kept entries of that name; re-added later, they stay.
 *   - Deduplicate by (name, args-JSON) preserving first occurrence.
 */
export function resolveModuleChain(
  layers: Array<Array<ModuleRefYaml> | undefined>,
): ModuleRef[] {
  const kept: ModuleRef[] = [];
  const seen = new Set<string>();
  for (const layer of layers) {
    if (!layer) continue;
    for (const yamlRef of layer) {
      const ref = refAsObject(yamlRef);
      if (ref.name.startsWith('-')) {
        const bareName = ref.name.slice(1);
        for (let i = kept.length - 1; i >= 0; i--) {
          if (kept[i]!.name === bareName) {
            seen.delete(`${bareName}::${argsKey(kept[i]!.args)}`);
            kept.splice(i, 1);
          }
        }
        continue;
      }
      const key = `${ref.name}::${argsKey(ref.args)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(ref);
    }
  }
  return kept;
}

export interface NormalizeInput {
  rule: RuleYaml;
  defaults?: FileDefaultsYaml;
  archetypes?: Record<string, ArchetypeYaml>;
  globalArchetypes?: Record<string, ArchetypeYaml>;
  meta: SourceMeta;
}

export function normalizeRule({
  rule,
  defaults,
  archetypes,
  globalArchetypes,
  meta,
}: NormalizeInput): PartialRule {
  const archetype = rule.archetype
    ? (archetypes?.[rule.archetype] ?? globalArchetypes?.[rule.archetype])
    : undefined;
  if (rule.archetype && !archetype) {
    throw new Error(
      `Rule "${rule.name}" references unknown archetype "${rule.archetype}"`,
    );
  }

  const ownMatchers = pickMatchers(rule);
  const hasOwnMatchers = Object.keys(ownMatchers).length > 0;

  const matchers = mergeMatchers(
    pickMatchers(defaults ?? {}),
    pickMatchers(archetype ?? {}),
    ownMatchers,
  );

  const actions = mergeActions(
    pickActions(defaults ?? {}),
    pickActions(archetype ?? {}),
    pickActions(rule),
  );

  const moduleChain = resolveModuleChain([
    defaults?.use,
    archetype?.use,
    rule.use,
  ]);

  const combinator = rule.combinator ?? archetype?.combinator ?? defaults?.combinator;
  const isEnabled = rule.is_enabled ?? archetype?.is_enabled ?? defaults?.is_enabled;

  return {
    name: rule.name,
    ...(isEnabled !== undefined ? { isEnabled } : {}),
    ...(combinator !== undefined ? { combinator } : {}),
    hasOwnMatchers,
    ...(rule.match_all !== undefined ? { matchAll: rule.match_all } : {}),
    matchers,
    actions,
    ...(rule.sort_order !== undefined ? { sortOrder: rule.sort_order } : {}),
    moduleChain,
    meta,
  };
}
