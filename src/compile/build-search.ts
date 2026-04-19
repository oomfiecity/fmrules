/**
 * Turn a PartialRule's Matchers into a SearchNode IR tree.
 *
 * Every matcher field is a MatcherValue: bare string, bare list (sugar
 * for `{any: [...]}`), or `{any?: [...], all?: [...]}` — `any` OR-joins,
 * `all` AND-joins, both → AND of the two groups. Distinct fields are
 * AND-joined at the top level. `match:` adds an arbitrary tree.
 * `search_raw` appends as a raw node.
 */

import type { MatchTree, MatcherValue, PartialRule } from '../types.ts';
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
 * `v => phrase(v)`, etc.). `combineOr` builds an OR group from leaves —
 * defaults to `or(...)`. Returns null when the value contributes nothing.
 */
function compileMatcherValue(
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

function compileMatchTree(node: MatchTree): SearchNode {
  if ('any' in node) {
    if (node.any.length === 0) throw new Error('match.any cannot be empty');
    if (node.any.length === 1) return compileMatchTree(node.any[0]!);
    return or(...node.any.map(compileMatchTree));
  }
  if ('all' in node) {
    if (node.all.length === 0) throw new Error('match.all cannot be empty');
    if (node.all.length === 1) return compileMatchTree(node.all[0]!);
    return and(...node.all.map(compileMatchTree));
  }
  if ('from' in node) return field('from', node.from);
  if ('to' in node) return field('to', node.to);
  if ('subject' in node) return field('subject', node.subject);
  if ('body' in node) return field('body', node.body);
  if ('with' in node) return field('with', node.with);
  if ('list' in node) return field('list', normalizeListId(node.list));
  if ('text' in node) return phrase(node.text);
  if ('header' in node) return headerNode(node.header.name, node.header.value);
  if ('raw' in node) return raw(node.raw);
  throw new Error(`Unrecognized match tree node: ${JSON.stringify(node)}`);
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

  if (m.match) parts.push(compileMatchTree(m.match));

  if (m.searchRaw) parts.push(raw(m.searchRaw));

  if (rule.extraSearch) parts.push(...rule.extraSearch);

  if (parts.length === 0) {
    throw new Error(`Rule "${rule.name}" has no matchers`);
  }
  if (parts.length === 1) return parts[0]!;
  return and(...parts);
}
