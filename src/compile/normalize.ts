/**
 * Turn a raw YAML rule entry into a PartialRule by:
 *   1. Resolving its referenced archetype (if any) against the file's archetypes.
 *   2. Merging file defaults + archetype + rule body (in that order).
 *   3. Lowering snake_case keys to camelCase for internal use.
 *   4. Resolving the module chain (concatenate layers, dedup by name+args, handle `-name` subtract).
 *
 * Does NOT build the search tree yet — that happens after modules run.
 */

import type {
  ActionsSchema,
  ArchetypeYaml,
  FileDefaultsYaml,
  MatchersSchema,
  ModuleRefYaml,
  RuleYaml,
} from '../schema/yaml.ts';
import type { z } from 'zod';
import type { Actions, MatchTree, Matchers, MatcherValue, ModuleRef, PartialRule, SourceMeta } from '../types.ts';

type ActionsYaml = z.infer<typeof ActionsSchema>;
type MatchersYaml = z.infer<typeof MatchersSchema>;

/**
 * Combine the singular field plus optional plural and `_all` siblings into
 * a single canonical MatcherValue. Within one layer:
 *   - bare string / list → contributes to `any` (OR-joined)
 *   - `_all` → contributes to `all` (AND-joined)
 *   - if only the singular is present and no plurals/_all, return it as-is
 */
function foldMatcher(
  singular: MatcherValue | undefined,
  plural: string[] | undefined,
  all: string[] | undefined,
): MatcherValue | undefined {
  const hasPlural = plural !== undefined && plural.length > 0;
  const hasAll = all !== undefined && all.length > 0;
  if (!hasPlural && !hasAll) return singular;

  const anyValues: string[] = [];
  const allValues: string[] = [...(all ?? [])];
  if (singular !== undefined) {
    if (typeof singular === 'string') anyValues.push(singular);
    else if (Array.isArray(singular)) anyValues.push(...singular);
    else {
      anyValues.push(...(singular.any ?? []));
      allValues.push(...(singular.all ?? []));
    }
  }
  if (hasPlural) anyValues.push(...plural);

  const out: { any?: string[]; all?: string[] } = {};
  if (anyValues.length > 0) out.any = anyValues;
  if (allValues.length > 0) out.all = allValues;
  return out;
}

function pickMatchers(src: Partial<MatchersYaml>): Matchers {
  const m: Matchers = {};
  if (src.from !== undefined) m.from = src.from as MatcherValue;
  if (src.to !== undefined) m.to = src.to as MatcherValue;
  const subject = foldMatcher(src.subject as MatcherValue | undefined, src.subjects, src.subject_all);
  if (subject !== undefined) m.subject = subject;
  const body = foldMatcher(src.body as MatcherValue | undefined, src.bodies, src.body_all);
  if (body !== undefined) m.body = body;
  if (src.header !== undefined) m.header = src.header;
  if (src.match !== undefined) m.match = src.match as MatchTree;
  if (src.list !== undefined) m.list = src.list as MatcherValue;
  if (src.with !== undefined) m.with = src.with as MatcherValue;
  if (src.text !== undefined) m.text = src.text as MatcherValue;
  if (src.domain !== undefined) m.domain = src.domain as MatcherValue;
  if (src.search_raw !== undefined) m.searchRaw = src.search_raw;
  return m;
}

function pickActions(src: Partial<ActionsYaml>): Actions {
  const a: Actions = {};
  if (src.skip_inbox !== undefined) a.skipInbox = src.skip_inbox;
  if (src.mark_read !== undefined) a.markRead = src.mark_read;
  if (src.mark_flagged !== undefined) a.markFlagged = src.mark_flagged;
  if (src.show_notification !== undefined) a.showNotification = src.show_notification;
  if (src.file_in !== undefined) a.fileIn = src.file_in;
  if (src.redirect_to !== undefined) {
    a.redirectTo = src.redirect_to === null
      ? null
      : Array.isArray(src.redirect_to)
        ? src.redirect_to
        : [src.redirect_to];
  }
  if (src.snooze_until !== undefined) a.snoozeUntil = src.snooze_until;
  if (src.discard !== undefined) a.discard = src.discard;
  if (src.mark_spam !== undefined) a.markSpam = src.mark_spam;
  if (src.stop !== undefined) a.stop = src.stop;
  return a;
}

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
 * Concatenate module chains from defaults → archetype → rule body, then:
 *   - Remove entries whose name starts with `-` (subtract; they strip any prior entry of that name).
 *   - Deduplicate by (name, args-JSON) preserving first occurrence.
 */
export function resolveModuleChain(
  layers: Array<Array<ModuleRefYaml> | undefined>,
): ModuleRef[] {
  const flat: ModuleRef[] = [];
  for (const layer of layers) {
    if (!layer) continue;
    for (const ref of layer) flat.push(refAsObject(ref));
  }
  const subtract = new Set<string>();
  const kept: ModuleRef[] = [];
  for (const ref of flat) {
    if (ref.name.startsWith('-')) {
      subtract.add(ref.name.slice(1));
      continue;
    }
  }
  const seen = new Set<string>();
  for (const ref of flat) {
    if (ref.name.startsWith('-')) continue;
    if (subtract.has(ref.name)) continue;
    const key = `${ref.name}::${argsKey(ref.args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(ref);
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
