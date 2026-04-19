/**
 * Render a SearchNode tree to a Fastmail search-query string.
 *
 * Precedence follows parseSearch.js:
 *   - `()` groups AND
 *   - `{}` groups OR (or explicit OR keyword between bare terms)
 *   - NOT is prefix `-` on a single term, or `NOT ` before a group
 *   - Bare space-separated terms default to AND
 */

import { flatten, type SearchNode } from './search-ir.ts';

/** Fastmail's search tokenizer treats these as boundaries; quote if present. */
const NEEDS_QUOTING = /[\s():{}"']/;

function quote(value: string): string {
  if (!NEEDS_QUOTING.test(value) && value.length > 0) return value;
  // Escape embedded double quotes; prefer double quotes for readability.
  return `"${value.replace(/"/g, '\\"')}"`;
}

function renderField(field: string, value: string): string {
  return `${field}:${quote(value)}`;
}

function renderHeader(name: string, value: string): string {
  // Fastmail header syntax is header:"Name:value" — the whole "Name:value"
  // is one quoted argument, regardless of internal colons/spaces.
  const payload = `${name}:${value}`;
  return `header:${quote(payload)}`;
}

function needsGrouping(parent: SearchNode, child: SearchNode): boolean {
  if (child.kind === 'and' || child.kind === 'or') {
    // Always group distinct binary operators.
    if (parent.kind === 'and' && child.kind === 'or') return true;
    if (parent.kind === 'or' && child.kind === 'and') return true;
  }
  return false;
}

function renderChild(parent: SearchNode, child: SearchNode): string {
  const rendered = render(child);
  if (needsGrouping(parent, child)) return `(${rendered})`;
  return rendered;
}

export function render(node: SearchNode): string {
  const n = flatten(node);
  switch (n.kind) {
    case 'and':
      return n.children.map((c) => renderChild(n, c)).join(' ');
    case 'or':
      return n.children.map((c) => renderChild(n, c)).join(' OR ');
    case 'not': {
      const inner = render(n.child);
      if (n.child.kind === 'and' || n.child.kind === 'or') return `NOT (${inner})`;
      return `-${inner}`;
    }
    case 'field':
      return renderField(n.field, n.value);
    case 'header':
      return renderHeader(n.name, n.value);
    case 'phrase':
      return quote(n.value);
    case 'raw':
      return n.value;
  }
}
