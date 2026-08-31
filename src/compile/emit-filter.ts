/**
 * Phase 5b — render a resolved condition tree as the structured rule
 * `filter` that Fastmail stores server-side and that `Rule/set` create
 * requires ("Need at least one of 'filter' or 'conditions'").
 *
 * Mirrors the server's own parse of the emitted search string. Probed
 * live 2026-08-31; note the evidence class — most probes below are
 * round-trips of this tool's OWN rules (Rule/get echoes what Rule/set
 * wrote), so they prove storage, not delivery-time matching:
 *
 *   search `from:x`            → {from: "x"} (whole header incl. display
 *                                name — live-verified: from "Boost" matches
 *                                display-name-only senders)
 *   search `tonotcc:x`         → {to: "x"}
 *   anywhere / raw             → see below (with: is NOT a usable operator)
 *   quoted values ("two words") → matched identically to unquoted
 *                                (live-verified: quoted and unquoted
 *                                subject filters return equal counts)
 *   search `header:"N:V"`      → {header: ["N", "V"]}
 *   search `list:<bare>`       → {listId: bare} — accepted by Rule/set
 *                                (creation live-verified via sync);
 *                                Email/query's listId condition silently
 *                                matches nothing
 *   search `to:x`              → OR over to/cc/bcc/deliveredTo
 *
 * Date bounds are inclusive at the boundary instant (live-verified:
 * after: <exact receivedAt> includes the message; +1s excludes it).
 *
 * `anywhere` and `raw:`:
 *
 *   - anywhere (SPEC §8: From, To, Cc, Bcc, Subject, or Body) renders as
 *     the exact six-field OR in both encodings. A previous version used
 *     the `with:` operator here on the claim that it covered address
 *     fields — live probing disproved that: with:tok inside a filter
 *     text value matches a narrow, undocumented set (with:telstra → 7
 *     messages, none of them among the 97 address-field matches), not
 *     the address fields and not full-text.
 *   - raw: passes through verbatim as the rule's {text} condition — the
 *     same string the search dialect stores, so both encodings of the
 *     rule mean the same query and Fastmail's own parser decides the
 *     semantics (SPEC §8.7). Rule/set accepts {text} filters verbatim
 *     (live-probed). No invented translation.
 *
 * Fail-closed: a single unsupported leaf (VIP / contact-group
 * membership) makes the WHOLE rule emit `filter: null`. Dropping the
 * leaf and emitting the remaining conjunction would install a rule
 * broader than the YAML — the negation or narrowing silently vanishes,
 * and nothing downstream can detect a non-null-but-partial filter.
 * With `filter: null`, `compile`/`check` surface the reason as a warning
 * (SPEC(10).md §11.5) and `fmrules sync` refuses the whole file rather
 * than wiping the account and failing mid-import. (`raw:` no longer
 * produces unsupported leaves — it passes through verbatim as {text}.)
 *
 * Date leaves pin day boundaries to UTC (see util/dates.ts) — the
 * structured filter is authoritative for Rule/set, so the emitted
 * timestamps, not Fastmail's date-only search parsing, decide the
 * boundaries.
 */

import { quote } from './emit.ts';
import { nextUtcMidnightIso, utcMidnightIso } from '../util/dates.ts';
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

interface RenderOut {
  /** Unsupported-leaf descriptions collected while rendering. */
  unsupported: string[];
}

/** Collapse single-condition ORs; otherwise build the OR group. */
function orOver(conditions: Record<string, string>[]): unknown {
  if (conditions.length === 1) return conditions[0];
  return { operator: 'OR', conditions };
}

/** Fields an address-field leaf covers: spec `to:` spans all four (§8.3). */
function addressFilterFields(field: string): string[] {
  switch (field) {
    case 'from':
      return ['from'];
    case 'to':
      return ['to', 'cc', 'bcc', 'deliveredTo'];
    case 'to_only':
      return ['to'];
    case 'cc':
      return ['cc'];
    case 'bcc':
      return ['bcc'];
    case 'delivered_to':
      return ['deliveredTo'];
    default:
      return [field];
  }
}

function renderPredicate(leaf: PredicateLeaf, out: RenderOut): unknown {
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
    case 'to_in_group': {
      const what =
        leaf.kind === 'from_in_vips'
          ? 'from_in_vips'
          : leaf.kind === 'to_in_vips'
            ? 'to_in_vips'
            : `${leaf.kind} "${leaf.group}"`;
      out.unsupported.push(`${what} has no structured-filter form`);
      return null;
    }
  }
}

function renderDate(leaf: DateLeaf): unknown {
  const conditions: unknown[] = [];
  if (leaf.equals) {
    conditions.push({ after: utcMidnightIso(leaf.equals) }, { before: nextUtcMidnightIso(leaf.equals) });
  }
  if (leaf.after) conditions.push({ after: utcMidnightIso(leaf.after) });
  if (leaf.before) conditions.push({ before: utcMidnightIso(leaf.before) });
  return conditions.length === 1 ? conditions[0] : { operator: 'AND', conditions };
}

/**
 * raw: passes through verbatim as the rule's text condition — exactly
 * the string the search dialect stores, so both encodings of the rule
 * mean the same query and the server's own parser decides the semantics
 * (SPEC §8.7: "takes a literal Fastmail search query as a string").
 * Verified storable: Rule/set accepts and stores {text} filters verbatim
 * (live-probed 2026-08-31). No invented translation — e.g. the old
 * `with:x` → address-fields OR rewrote the author's query into a
 * different one.
 */
function renderRaw(leaf: RawLeaf): unknown {
  return { text: leaf.value };
}

function renderLeaf(node: Condition, out: RenderOut): unknown {
  switch (node.kind) {
    case 'phrase': {
      const leaf = node as PhraseLeaf;
      switch (leaf.field) {
        case 'subject':
          return { subject: quote(leaf.value) };
        case 'body':
          return { body: quote(leaf.value) };
        case 'anywhere':
          // SPEC §8: anywhere = From, To, Cc, Bcc, Subject, or Body — the
          // exact six-field OR (mirrors the search string's six-arm form).
          // The previous `with:` rendering relied on an operator that
          // live probing showed does not exist as documented: with:tok
          // inside a text value matched a narrow undocumented set, not
          // the address fields, not full-text.
          return orOver(
            ['from', 'to', 'cc', 'bcc', 'subject', 'body'].map((f) => ({ [f]: quote(leaf.value) })),
          );
        case 'attachment_name':
          return { hasAttachment: true, attachmentName: quote(leaf.value) };
      }
      break;
    }
    case 'address': {
      // The parsed filter value is the search token exactly as the
      // search string wrote it — quotes included when the renderer
      // quoted it (hyphens, spaces, …), bare when it didn't.
      const fields = addressFilterFields(node.field);
      if (node.match === 'domain_or_subdomain') {
        // Subdomain-inclusive per SPEC §8.3: live-verified, the @ arm
        // matches only the apex domain, so OR it with a dot-anchored arm
        // for subdomains (mirrors the search string's from:(@d OR .d)).
        const values = [quote(`@${node.value}`), quote(`.${node.value}`)];
        const conditions = fields.flatMap((f) => values.map((v) => ({ [f]: v })));
        return conditions.length === 1 ? conditions[0] : { operator: 'OR', conditions };
      }
      const value = node.match === 'domain' ? quote(`@${node.value}`) : quote(node.value);
      const conditions = fields.map((f) => ({ [f]: value }));
      return conditions.length === 1 ? conditions[0] : { operator: 'OR', conditions };
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
      return renderRaw(node as RawLeaf);
    default:
      return renderPredicate(node as PredicateLeaf, out);
  }
}

function renderNode(node: Condition, out: RenderOut): unknown {
  switch (node.kind) {
    case 'all': {
      const children = node.children.map((c) => renderNode(c, out));
      // Fail-closed: a null child means an unsupported leaf — dropping it
      // would silently broaden the rule, so the whole group is null.
      if (children.some((c) => c === null)) return null;
      if (children.length === 0) return null;
      if (children.length === 1) return children[0];
      return { operator: 'AND', conditions: children };
    }
    case 'any': {
      const children = node.children.map((c) => renderNode(c, out));
      if (children.some((c) => c === null)) return null;
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
  const out: RenderOut = { unsupported: [] };
  const filter = renderNode(resolved, out);
  if (out.unsupported.length > 0) {
    return { filter: null, unsupported: out.unsupported.join('; ') };
  }
  return { filter, unsupported: filter === null ? 'condition produced no filter' : null };
}
