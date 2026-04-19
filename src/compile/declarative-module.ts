/**
 * Compile a declarative YAML module into a runtime Module.
 *
 * A declarative module names a matcher field (e.g. `from`) and an IR
 * expression to replace that field's value with. Occurrences of `{value}`
 * in the IR expression are substituted with the field's concrete value.
 *
 * This covers the SimpleLogin-style use case and most forwarder bridges
 * without requiring TS. Anything more complex (fan-out, computed data,
 * action mutation) should be a .ts module.
 */

import type { Module } from '../module.ts';
import type { DeclarativeModuleYaml } from '../schema/yaml.ts';
import type { Matchers, PartialRule } from '../types.ts';
import {
  and as irAnd,
  field as irField,
  header as irHeader,
  or as irOr,
  raw as irRaw,
  type SearchField,
  type SearchNode,
} from './search-ir.ts';


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

function interpolate(tpl: string, value: string): string {
  return tpl.replace(/\{value\}/g, value);
}

function buildTransformIR(node: unknown, value: string): SearchNode {
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if ('or' in obj && Array.isArray(obj.or)) {
      return irOr(...obj.or.map((c) => buildTransformIR(c, value)));
    }
    if ('and' in obj && Array.isArray(obj.and)) {
      return irAnd(...obj.and.map((c) => buildTransformIR(c, value)));
    }
    for (const fld of ['from', 'to', 'subject', 'body'] as const) {
      if (fld in obj && typeof obj[fld] === 'string') {
        return irField(fld as SearchField, interpolate(obj[fld] as string, value));
      }
    }
    if ('header' in obj && obj.header && typeof obj.header === 'object') {
      const h = obj.header as { name?: string; value?: string; contains?: string };
      const name = h.name ?? '';
      const v = h.value ?? h.contains ?? '';
      return irHeader(interpolate(name, value), interpolate(v, value));
    }
    if ('raw' in obj && typeof obj.raw === 'string') {
      return irRaw(interpolate(obj.raw as string, value));
    }
  }
  throw new Error(`Unrecognized declarative transform node: ${JSON.stringify(node)}`);
}

/**
 * Replace a matcher field's values on a rule using the module's transform.
 * Produces a SearchNode IR tree pushed onto the rule's extraSearch list;
 * the original matcher value is removed so buildSearch doesn't also emit it.
 * Multiple matcher values are OR-joined.
 */
function applyToRule(
  rule: PartialRule,
  targetKey: MatcherKey,
  transformTree: unknown,
): PartialRule {
  const m = rule.matchers;
  const current = m[targetKey];
  if (current === undefined) return rule;

  let values: string[] = [];
  if (typeof current === 'string') values = [current];
  else if (Array.isArray(current)) values = current.filter((v): v is string => typeof v === 'string');
  else if (current && typeof current === 'object' && !('name' in current)) {
    const v = current as { any?: string[]; all?: string[] };
    values = [...(v.any ?? []), ...(v.all ?? [])];
  } else return rule; // header objects — out of scope for declarative modules

  if (values.length === 0) return rule;

  const branches = values.map((v) => buildTransformIR(transformTree, v));
  const bundled: SearchNode = branches.length === 1 ? branches[0]! : irOr(...branches);

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
          if (tree !== undefined) next = applyToRule(next, t, tree);
        }
        return next;
      });
    },
  };
}
