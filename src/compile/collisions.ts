/**
 * SPEC(10).md §8.9 — a field may not appear twice as direct children of
 * the same `all:` combinator WHEN both leaves use a single-value match
 * type. `all: [from: { address: A }, from: { address: B }]` can never
 * match (one From header can't equal two distinct addresses). But
 * `all: [subject: { contains: A }, subject: { contains: B }]` is fine —
 * one subject can contain both substrings simultaneously.
 *
 * Applied AFTER extends resolution (§9.2), so literal + extends-sourced
 * conflicts are caught uniformly. Does not apply inside `any:` (disjunction
 * of two senders is meaningful), nor at different nesting depths.
 *
 * Single-value match types (collision applies):
 *   address fields with `address` / `domain` / `domain_or_subdomain`,
 *   phrase fields with `equals`,
 *   `header: { exists / equals }` keyed by header name,
 *   `list_id`, `priority`, every boolean predicate (has_attachment,
 *   from_in_contacts/vips, to_in_contacts/vips, conv_*, msg_*).
 *
 * Multi-value / containment match types (no collision):
 *   `contains` / `prefix` / `suffix` (subject, body, address fields,
 *   header values — multiple substrings can co-exist on one header value),
 *   `larger_than` / `smaller_than` (combine to form ranges),
 *   `filetype` / `mimetype` (a message can have multiple attachments of
 *   different types — multiple leaves are conjuncts not collisions),
 *   `from_in_group` / `to_in_group` (a contact can be in multiple
 *   groups), `raw`, `date` (multiple date leaves are unusual but
 *   satisfiable when each carries a different bound).
 */

import type { Condition, Rule } from '../types.ts';
import type { ErrorCollector } from './errors.ts';

/** Derive a stable collision key for a leaf — same key = same "field"
 *  in single-value space. Returns null for match types that allow
 *  multiple co-satisfiable leaves under one `all:`. */
function collisionKeyOf(node: Condition): string | null {
  switch (node.kind) {
    case 'phrase':
      // contains / prefix / suffix can co-satisfy on one header value;
      // only `equals` is mutually exclusive across distinct values.
      return node.match === 'equals' ? `phrase:${node.field}:equals` : null;
    case 'address':
      // contains / prefix can co-satisfy. address / domain / domain_or_subdomain
      // each pin the From header to a single value space.
      return node.match === 'contains' || node.match === 'prefix'
        ? null
        : `address:${node.field}:${node.match}`;
    case 'list_id':
      return 'list_id';
    case 'size':
      // larger_than X + larger_than Y is satisfiable (take max bound);
      // larger_than + smaller_than forms a range. No collision.
      return null;
    case 'priority':
    case 'has_attachment':
    case 'has_list_id':
    case 'from_in_contacts':
    case 'from_in_vips':
    case 'to_in_contacts':
    case 'to_in_vips':
    case 'conv_followed':
    case 'conv_muted':
    case 'msg_pinned':
    case 'msg_replied':
      return `pred:${node.kind}`;
    case 'from_in_group':
    case 'to_in_group':
      // A contact can belong to multiple groups; multiple leaves are
      // a meaningful conjunction.
      return null;
    case 'filetype':
    case 'mimetype':
      // A message with multiple attachments can satisfy multiple type
      // predicates at once.
      return null;
    case 'header_exists':
    case 'header_equals':
      return `${node.kind}:${node.name.toLowerCase()}`;
    case 'header_contains':
    case 'header_prefix':
    case 'header_suffix':
      return null;
    case 'date':
      // Two date leaves with different bounds form a range; not a collision.
      return null;
    case 'raw':
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
