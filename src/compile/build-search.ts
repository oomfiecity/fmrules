/**
 * Turn a PartialRule's Matchers into a SearchNode IR tree.
 *
 * Every matcher field is a MatcherValue: bare string, bare list (sugar
 * for `{any: [...]}`), or `{any?: [...], all?: [...]}` — `any` OR-joins,
 * `all` AND-joins, both → AND of the two groups. Distinct fields are
 * AND-joined at the top level. `match:` adds an arbitrary tree.
 * `search_raw` appends as a raw node.
 */

import type { MatcherValue, PartialRule, SearchExpr } from '../types.ts';
import {
  and,
  field,
  header as headerNode,
  or,
  phrase,
  raw,
  type SearchField,
  type SearchNode,
} from './search-ir.ts';

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function ruleErr(rule: PartialRule, msg: string): Error {
  return new Error(`Rule "${rule.name}" (${rule.meta.file}): ${msg}`);
}

function fieldGroup(f: SearchField, values: string[]): SearchNode | null {
  if (values.length === 0) return null;
  if (values.length === 1) return field(f, values[0]!);
  return or(...values.map((v) => field(f, v)));
}

function headerGroup(entries: Array<{ name: string; value: string }>): SearchNode | null {
  if (entries.length === 0) return null;
  if (entries.length === 1) return headerNode(entries[0]!.name, entries[0]!.value);
  return or(...entries.map((e) => headerNode(e.name, e.value)));
}

function normalizeListId(value: string): string {
  const stripped = value.replace(/^<+/, '').replace(/>+$/, '');
  return `<${stripped}>`;
}

/**
 * Compile a single matcher value into an IR node. `toLeaf` builds the
 * terminal node for a single string value (`v => field('from', v)`,
 * `v => phrase(v)`, etc.). Returns null when the value contributes nothing.
 *
 * Exported so declarative-module's `applyToRule` can reuse the same
 * MatcherValue → IR walk (with a `toLeaf` that runs the transform per
 * value), inheriting the correct `{any, all}` AND-of-groups semantics.
 */
export function compileMatcherValue(
  val: MatcherValue,
  toLeaf: (v: string) => SearchNode,
): SearchNode | null {
  if (typeof val === 'string') return toLeaf(val);
  if (Array.isArray(val)) {
    if (val.length === 0) return null;
    if (val.length === 1) return toLeaf(val[0]!);
    return or(...val.map(toLeaf));
  }
  const anyVals = val.any ?? [];
  const allVals = val.all ?? [];
  const parts: SearchNode[] = [];
  if (anyVals.length > 0) {
    parts.push(anyVals.length === 1 ? toLeaf(anyVals[0]!) : or(...anyVals.map(toLeaf)));
  }
  for (const v of allVals) parts.push(toLeaf(v));
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!;
  return and(...parts);
}

function compileMatchLeaf(
  val: MatcherValue,
  toLeaf: (v: string) => SearchNode,
  fieldName: string,
  rule: PartialRule,
): SearchNode {
  const compiled = compileMatcherValue(val, toLeaf);
  if (compiled === null) {
    throw ruleErr(rule, `match.${fieldName} cannot be empty`);
  }
  return compiled;
}

/**
 * Compile the shared SearchExpr grammar (rule `match:` and declarative
 * module `transform:`) to SearchNode IR. Leaves delegate to
 * `compileMatchLeaf`, so every leaf kind accepts the full MatcherValue
 * value shape (string | string[] | {any, all}). `rule` is threaded through
 * recursion so thrown errors carry rule-name + file context at the throw
 * site — no outer wrapping needed.
 */
export function compileSearchExpr(node: SearchExpr, rule: PartialRule): SearchNode {
  if ('any' in node) {
    if (node.any.length === 0) throw ruleErr(rule, 'match.any cannot be empty');
    if (node.any.length === 1) return compileSearchExpr(node.any[0]!, rule);
    return or(...node.any.map((c) => compileSearchExpr(c, rule)));
  }
  if ('all' in node) {
    if (node.all.length === 0) throw ruleErr(rule, 'match.all cannot be empty');
    if (node.all.length === 1) return compileSearchExpr(node.all[0]!, rule);
    return and(...node.all.map((c) => compileSearchExpr(c, rule)));
  }
  if ('from' in node) return compileMatchLeaf(node.from, (v) => field('from', v), 'from', rule);
  if ('to' in node) return compileMatchLeaf(node.to, (v) => field('to', v), 'to', rule);
  if ('subject' in node) return compileMatchLeaf(node.subject, (v) => field('subject', v), 'subject', rule);
  if ('body' in node) return compileMatchLeaf(node.body, (v) => field('body', v), 'body', rule);
  if ('with' in node) return compileMatchLeaf(node.with, (v) => field('with', v), 'with', rule);
  if ('list' in node) return compileMatchLeaf(node.list, (v) => field('list', normalizeListId(v)), 'list', rule);
  if ('text' in node) return compileMatchLeaf(node.text, (v) => phrase(v), 'text', rule);
  if ('domain' in node) return compileMatchLeaf(node.domain, (v) => field('from', `@${v}`), 'domain', rule);
  if ('header' in node) return headerNode(node.header.name, node.header.value);
  if ('raw' in node) return raw(node.raw);
  throw ruleErr(rule, `unrecognized search expression node: ${JSON.stringify(node)}`);
}

export function buildSearch(rule: PartialRule): SearchNode {
  const m = rule.matchers;
  const parts: SearchNode[] = [];

  const push = (n: SearchNode | null | undefined): void => {
    if (n) parts.push(n);
  };

  if (m.from !== undefined) push(compileMatcherValue(m.from, (v) => field('from', v)));
  if (m.to !== undefined) push(compileMatcherValue(m.to, (v) => field('to', v)));
  if (m.subject !== undefined) push(compileMatcherValue(m.subject, (v) => field('subject', v)));
  if (m.body !== undefined) push(compileMatcherValue(m.body, (v) => field('body', v)));

  const headers = asArray(m.header);
  push(headerGroup(headers));

  if (m.with !== undefined) push(compileMatcherValue(m.with, (v) => field('with', v)));
  if (m.list !== undefined) push(compileMatcherValue(m.list, (v) => field('list', normalizeListId(v))));
  if (m.text !== undefined) push(compileMatcherValue(m.text, (v) => phrase(v)));
  if (m.domain !== undefined) push(compileMatcherValue(m.domain, (v) => field('from', `@${v}`)));

  if (m.match) parts.push(compileSearchExpr(m.match, rule));

  if (m.searchRaw) parts.push(raw(m.searchRaw));

  if (rule.extraSearch) parts.push(...rule.extraSearch);

  if (parts.length === 0) {
    throw ruleErr(rule, 'has no matchers');
  }
  if (parts.length === 1) return parts[0]!;
  return and(...parts);
}
