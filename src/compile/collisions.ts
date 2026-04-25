/**
 * SPEC(10).md §8.9 — a field may not appear twice as direct children of
 * the same `all:` combinator. `all: [from: X, from: Y]` can never match
 * (one message has one From header), so the compiler flags this as a
 * bug rather than accepting a dead rule.
 *
 * Applied AFTER extends resolution (§9.2), so literal + extends-sourced
 * conflicts are caught uniformly. Does not apply inside `any:` (disjunction
 * of two senders is meaningful), nor at different nesting depths.
 *
 * The "field" for collision purposes is the leaf's sort key — i.e. two
 * `from:` leaves always collide, two `header:` leaves collide only if
 * their header names match (case-insensitively per RFC 5322).
 */

import type { Condition, Rule } from '../types.ts';
import type { ErrorCollector } from './errors.ts';

/** Derive a stable collision key for a leaf — same key = same "field". */
function collisionKeyOf(node: Condition): string | null {
  switch (node.kind) {
    case 'phrase':
      return `phrase:${node.field}`;
    case 'address':
      return `address:${node.field}`;
    case 'list_id':
      return 'list_id';
    case 'size':
      return `size:${node.op}`;
    case 'priority':
    case 'has_attachment':
    case 'has_list_id':
    case 'from_in_contacts':
    case 'from_in_vips':
    case 'from_in_group':
    case 'to_in_contacts':
    case 'to_in_vips':
    case 'to_in_group':
    case 'conv_followed':
    case 'conv_muted':
    case 'msg_pinned':
    case 'msg_replied':
    case 'filetype':
    case 'mimetype':
      return `pred:${node.kind}`;
    case 'header_exists':
    case 'header_equals':
    case 'header_contains':
    case 'header_prefix':
    case 'header_suffix':
      return `header:${node.name.toLowerCase()}`;
    case 'date':
      return 'date';
    case 'raw':
      // Two distinct `raw:` leaves are treated as distinct fields — there's
      // no way to know whether two raw strings are semantically alike.
      return null;
    case 'all':
    case 'any':
    case 'not':
    case 'extends':
      return null;
  }
}

/**
 * Walk the tree, checking every `all:` node for duplicate direct-child
 * field keys. Pushes one error per collision.
 */
export function checkCollisions(rule: Rule, resolved: Condition, errors: ErrorCollector): void {
  walk(resolved, rule, errors);
}

function walk(node: Condition, rule: Rule, errors: ErrorCollector): void {
  if (node.kind === 'all') {
    const seen = new Map<string, number>();
    for (const c of node.children) {
      const k = collisionKeyOf(c);
      if (k !== null) {
        seen.set(k, (seen.get(k) ?? 0) + 1);
      }
      walk(c, rule, errors);
    }
    for (const [k, n] of seen) {
      if (n > 1) {
        errors.error({
          file: rule.sourceFile,
          tag: '12.4',
          message: `rule "${rule.name}": field "${formatKey(k)}" appears ${n} times as direct children of an \`all:\` — a single message cannot satisfy both (§8.9). Use \`any:\` for disjunction.`,
        });
      }
    }
    return;
  }
  if (node.kind === 'any') {
    for (const c of node.children) walk(c, rule, errors);
    return;
  }
  if (node.kind === 'not') {
    walk(node.child, rule, errors);
  }
}

function formatKey(k: string): string {
  // Drop internal prefixes for user-friendly error output.
  if (k.startsWith('phrase:')) return k.slice('phrase:'.length);
  if (k.startsWith('address:')) return k.slice('address:'.length);
  if (k.startsWith('pred:')) return k.slice('pred:'.length);
  if (k.startsWith('size:')) return k.slice('size:'.length);
  if (k.startsWith('header:')) return `header[${k.slice('header:'.length)}]`;
  return k;
}
