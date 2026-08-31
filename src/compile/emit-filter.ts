/**
 * Phase 5b — render a resolved condition tree as the structured rule
 * `filter` that Fastmail stores server-side and that `Rule/set` create
 * requires ("Need at least one of 'filter' or 'conditions'").
 *
 * Mirrors the server's own parse of the emitted search string, verified
 * against live Rule/get output (2026-08-31):
 *
 *   search `from:x`            → {from: "x"}
 *   search `tonotcc:x`         → {to: "x"}
 *   search `with:x`            → OR over from/to/cc/bcc/deliveredTo
 *                                (NOT a text match — this is how the
 *                                server parses the `with:` operator,
 *                                including `raw: with:via`)
 *   search `header:"N:V"`      → {header: ["N", "V"]}
 *   search `list:<bare>`       → {listId: bare} — valid in the rule
 *                                grammar even though Email/query filters
 *                                reject a listId condition
 *   search `to:x`              → OR over to/cc/bcc/deliveredTo
 *
 * Unsupported leaves (VIP / contact-group membership, `raw:` forms beyond
 * `with:`) yield filter: null — such rules still emit with their search
 * string, and `fmrules sync` refuses to destroy the existing set when the
 * incoming file contains them rather than wiping the account and failing
 * mid-import.
 */

import { quote } from './emit.ts';
import type {
  Condition,
  DateLeaf,
  PhraseLeaf,
  PredicateLeaf,
  RawLeaf,
  SizeLeaf,
  When,
} from '../types.ts';

export interface RenderedRuleFilter {
  /** Structured filter for Rule/set create, or null when unevaluable. */
  filter: unknown;
  /** Human-readable leaf description when filter is null. */
  unsupported: string | null;
}

/** Fastmail parses `with:X` (and spec `to:`) as an OR across address fields. */
function addressOr(fields: string[], value: string): unknown {
  const conditions = fields.map((f) => ({ [f]: value }));
  if (conditions.length === 1) return conditions[0];
  return { operator: 'OR', conditions };
}

function renderPredicate(leaf: PredicateLeaf): unknown {
  switch (leaf.kind) {
    case 'priority':
      return { isHighPriority: true };
    case 'has_attachment':
      return { hasAttachment: true };
    case 'has_list_id':
      return { header: ['List-Id'] };
    case 'from_in_contacts':
      return { fromAnyContact: true };
    case 'to_in_contacts':
      return {
        operator: 'OR',
        conditions: [{ toAnyContact: true }, { ccAnyContact: true }, { bccAnyContact: true }],
      };
    case 'conv_followed':
      return { hasKeyword: '$followed' };
    case 'conv_muted':
      return { hasKeyword: '$muted' };
    case 'msg_pinned':
      return { hasKeyword: '$flagged' };
    case 'msg_replied':
      return { hasKeyword: '$answered' };
    case 'filetype':
      return { attachmentType: leaf.value };
    case 'mimetype':
      return { text: `mimetype:${leaf.value}` };
    case 'from_in_vips':
    case 'to_in_vips':
    case 'from_in_group':
    case 'to_in_group':
      return null; // signaled to the caller as unsupported
  }
}

function renderDate(leaf: DateLeaf): unknown {
  const conditions: unknown[] = [];
  const midnight = (d: string) => new Date(`${d}T00:00:00`).toISOString();
  if (leaf.equals) {
    conditions.push(
      { after: midnight(leaf.equals) },
      { before: new Date(new Date(`${leaf.equals}T00:00:00`).getTime() + 24 * 3600 * 1000).toISOString() },
    );
  }
  if (leaf.after) conditions.push({ after: midnight(leaf.after) });
  if (leaf.before) conditions.push({ before: midnight(leaf.before) });
  return conditions.length === 1 ? conditions[0] : { operator: 'AND', conditions };
}

/** Minimal raw: parser — `with:VALUE` (the only raw form this repo uses). */
function renderRaw(leaf: RawLeaf, out: { unsupported: string | null }): unknown {
  const m = leaf.value.match(/^with:(\S+)$/);
  // Raw values pass through the search string verbatim — unquoted — so
  // the parsed filter value is bare even when it contains hyphens.
  if (m) return addressOr(['from', 'to', 'cc', 'bcc', 'deliveredTo'], m[1]!);
  out.unsupported = `raw condition "${leaf.value}" has no structured-filter translation`;
  return null;
}

function renderLeaf(node: Condition, out: { unsupported: string | null }): unknown {
  switch (node.kind) {
    case 'phrase': {
      const leaf = node as PhraseLeaf;
      switch (leaf.field) {
        case 'subject':
          return { subject: quote(leaf.value) };
        case 'body':
          return { body: quote(leaf.value) };
        case 'anywhere':
          // Fastmail's `with:` operator covers the address fields only.
          return addressOr(['from', 'to', 'cc', 'bcc', 'deliveredTo'], quote(leaf.value));
        case 'attachment_name':
          return { hasAttachment: true, attachmentName: quote(leaf.value) };
      }
      break;
    }
    case 'address': {
      // The parsed filter value is the search token exactly as the
      // search string wrote it — quotes included when the renderer
      // quoted it (hyphens, spaces, …), bare when it didn't.
      const value =
        node.match === 'domain' || node.match === 'domain_or_subdomain' ? quote(`@${node.value}`) : quote(node.value);
      switch (node.field) {
        case 'from':
          return { from: value };
        case 'to':
          return addressOr(['to', 'cc', 'bcc', 'deliveredTo'], value);
        case 'to_only':
          return { to: value };
        case 'cc':
          return { cc: value };
        case 'bcc':
          return { bcc: value };
        case 'delivered_to':
          return { deliveredTo: value };
      }
      break;
    }
    case 'list_id':
      return { listId: node.value.replace(/^<+/, '').replace(/>+$/, '') };
    case 'size': {
      const leaf = node as SizeLeaf;
      return leaf.op === 'larger_than' ? { minSize: leaf.bytes } : { maxSize: leaf.bytes };
    }
    case 'header_exists':
      return { header: [node.name] };
    case 'header_equals':
    case 'header_contains':
    case 'header_prefix':
    case 'header_suffix':
      return { header: [node.name, node.value] };
    case 'date':
      return renderDate(node as DateLeaf);
    case 'raw':
      return renderRaw(node as RawLeaf, out);
    default:
      return renderPredicate(node as PredicateLeaf);
  }
}

function renderNode(node: Condition, out: { unsupported: string | null }): unknown {
  switch (node.kind) {
    case 'all': {
      const children = node.children.map((c) => renderNode(c, out)).filter((c) => c !== null);
      if (children.length === 0) return null;
      if (children.length === 1) return children[0];
      return { operator: 'AND', conditions: children };
    }
    case 'any': {
      const children = node.children.map((c) => renderNode(c, out)).filter((c) => c !== null);
      if (children.length === 0) return null;
      if (children.length === 1) return children[0];
      return { operator: 'OR', conditions: children };
    }
    case 'not': {
      const inner = renderNode(node.child, out);
      if (inner === null) return null;
      return { operator: 'NOT', conditions: [inner] };
    }
    case 'extends':
      throw new Error('emitRuleFilter called on unresolved extends (internal error)');
    default:
      return renderLeaf(node, out);
  }
}

export function emitRuleFilter(when: When, resolved: Condition | null): RenderedRuleFilter {
  if (when.kind === 'always') {
    // `when: always` has no filter expression; the rule grammar has no
    // match-everything condition we've verified. Signal unsupported —
    // sync will refuse loudly rather than creating a rule that matches
    // nothing.
    return { filter: null, unsupported: 'when: always has no structured-filter form' };
  }
  if (!resolved) return { filter: null, unsupported: 'no resolved condition' };
  const out: { unsupported: string | null } = { unsupported: null };
  const filter = renderNode(resolved, out);
  return { filter, unsupported: filter === null ? (out.unsupported ?? 'condition produced no filter') : null };
}
