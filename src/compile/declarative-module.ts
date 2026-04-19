/**
 * Compile a declarative YAML module into a runtime Module.
 *
 * A declarative module names a matcher field (e.g. `from`) and a SearchExpr
 * tree to replace that field's value with. `{value}` in any string position
 * inside the tree is substituted with the matcher's concrete value at
 * module-application time. The grammar is the same one rule `match:` trees
 * use — see `SearchExprSchema` in `src/schema/yaml.ts`.
 */

import type { Module } from '../module.ts';
import type { DeclarativeModuleYaml } from '../schema/yaml.ts';
import type { Matchers, MatcherValue, PartialRule, SearchExpr } from '../types.ts';
import { compileMatcherValue, compileSearchExpr } from './build-search.ts';


type MatcherKey = keyof Matchers;

const MATCHER_KEYS: readonly MatcherKey[] = [
  'from',
  'to',
  'subject',
  'body',
  'header',
  'searchRaw',
];

function isMatcherKey(x: string): x is MatcherKey {
  return (MATCHER_KEYS as readonly string[]).includes(x);
}

/**
 * Substitute `{value}` in every string position of a MatcherValue. Uses
 * `.replaceAll` (string form) so `$`/`$&` in `value` aren't interpreted as
 * regex back-references in the replacement.
 */
function interpolateMatcherValue(v: MatcherValue, value: string): MatcherValue {
  if (typeof v === 'string') return v.replaceAll('{value}', value);
  if (Array.isArray(v)) return v.map((s) => s.replaceAll('{value}', value));
  return {
    ...(v.any && { any: v.any.map((s) => s.replaceAll('{value}', value)) }),
    ...(v.all && { all: v.all.map((s) => s.replaceAll('{value}', value)) }),
  };
}

/**
 * Walk a SearchExpr and substitute `{value}` in every string position
 * (leaf MatcherValues, header name + value, raw fragment). Structural
 * nodes (`any`/`all`) recurse; values are replaced via string
 * `.replaceAll` to avoid regex-special-char corruption.
 */
function interpolateSearchExpr(expr: SearchExpr, value: string): SearchExpr {
  if ('any' in expr) return { any: expr.any.map((c) => interpolateSearchExpr(c, value)) };
  if ('all' in expr) return { all: expr.all.map((c) => interpolateSearchExpr(c, value)) };
  if ('from' in expr) return { from: interpolateMatcherValue(expr.from, value) };
  if ('to' in expr) return { to: interpolateMatcherValue(expr.to, value) };
  if ('subject' in expr) return { subject: interpolateMatcherValue(expr.subject, value) };
  if ('body' in expr) return { body: interpolateMatcherValue(expr.body, value) };
  if ('with' in expr) return { with: interpolateMatcherValue(expr.with, value) };
  if ('list' in expr) return { list: interpolateMatcherValue(expr.list, value) };
  if ('text' in expr) return { text: interpolateMatcherValue(expr.text, value) };
  if ('domain' in expr) return { domain: interpolateMatcherValue(expr.domain, value) };
  if ('header' in expr) {
    return {
      header: {
        name: expr.header.name.replaceAll('{value}', value),
        value: expr.header.value.replaceAll('{value}', value),
      },
    };
  }
  return { raw: expr.raw.replaceAll('{value}', value) };
}

/**
 * Replace a matcher field's values on a rule using the module's transform.
 * Produces a SearchNode IR tree pushed onto the rule's extraSearch list;
 * the original matcher value is removed so buildSearch doesn't also emit it.
 *
 * Per-value IR composition is delegated to `compileMatcherValue`, the same
 * helper buildSearch uses — so string / string[] / `{any, all}` all compose
 * identically here as there. Each leaf runs `compileSearchExpr` on the
 * interpolated transform tree for that one value.
 */
function applyToRule(
  rule: PartialRule,
  targetKey: MatcherKey,
  transformTree: SearchExpr,
): PartialRule {
  const m = rule.matchers;
  const current = m[targetKey];
  if (current === undefined) return rule;
  // Header-typed matchers: declarative modules don't target `header:`.
  if (
    current &&
    typeof current === 'object' &&
    !Array.isArray(current) &&
    'name' in current
  ) {
    return rule;
  }

  const bundled = compileMatcherValue(current as MatcherValue, (v) =>
    compileSearchExpr(interpolateSearchExpr(transformTree, v), rule),
  );
  if (!bundled) return rule;

  const nextMatchers: Matchers = { ...m };
  delete nextMatchers[targetKey];
  return {
    ...rule,
    matchers: nextMatchers,
    extraSearch: [...(rule.extraSearch ?? []), bundled],
  };
}

export function buildDeclarativeModule(decl: DeclarativeModuleYaml): Module {
  const targets = Array.isArray(decl.targets) ? decl.targets : [decl.targets];
  for (const t of targets) {
    if (!isMatcherKey(t)) {
      throw new Error(
        `Declarative module "${decl.module}": unknown target field "${t}"`,
      );
    }
  }
  const validTargets = targets.filter(isMatcherKey);

  return {
    name: decl.module,
    description: decl.description,
    apply(rules: PartialRule[]): PartialRule[] {
      return rules.map((r) => {
        let next = r;
        for (const t of validTargets) {
          const tree = decl.transform[t];
          if (tree !== undefined) next = applyToRule(next, t, tree as SearchExpr);
        }
        return next;
      });
    },
  };
}
