/**
 * Render a spec Condition tree as a structured JMAP Email/query filter.
 *
 * The live `verify`/`apply` commands evaluate rules by asking Fastmail's
 * search engine which messages a rule's condition matches (SPEC(10).md
 * §11.3: retroactive application as an external JMAP operation). This is
 * the query-side counterpart to emit.ts: the same resolved Condition tree
 * that emit.ts renders into Fastmail's rule-import search string is
 * rendered here into the structured FilterCondition grammar the JMAP
 * Email/query method accepts.
 *
 * Field mapping notes (verified against the web client's own search
 * parser, which produces exactly these shapes for the corresponding
 * search operators):
 *
 *   spec `from`        → {from}                     (search from:)
 *   spec `to`          → OR to/cc/bcc/deliveredTo   (§8.3: to: covers all four)
 *   spec `to_only`     → {to}                       (search tonotcc:)
 *   spec `delivered_to`→ {deliveredTo}              (search deliveredto:)
 *   spec `anywhere`    → {text}                     (search with:)
 *   spec `attachment_name` → {hasAttachment, attachmentName}
 *   spec `list_id`     → {header: [List-Id, <value>]} (exact via bracket anchor)
 *   spec `size`        → {minSize}/{maxSize}
 *   predicates         → hasKeyword/$seen-family, isHighPriority,
 *                        attachmentType, fromAnyContact, …
 *   spec `date`        → {after}/{before} ISO timestamps (UTC midnight —
 *                        the same boundary the compile-side rule filter
 *                        emitter pins via util/dates.ts, so verify/apply
 *                        evaluate the same windows the installed rules
 *                        use)
 *   spec `raw`         → {text} (passed through verbatim; the compiler's
 *                        stripped-operator scan (§8.7) has already refused
 *                        operators Fastmail's rule engine drops, so
 *                        anything that compiles is at least search-valid)
 *
 * Two predicate families cannot be expressed server-side and are reported
 * as unsupported so callers can warn: VIP membership and contact-group
 * membership (the web client resolves those to contact-card UIDs, which
 * this renderer cannot look up).
 *
 * Delivery-time caveat: `conv_followed`, `conv_muted`, `msg_pinned` and
 * `msg_replied` match against CURRENT message state (§ "On rule execution
 * context"), which is not necessarily the state at delivery time.
 *
 * Divergence caveat — `anywhere` and `raw: with:`: the compile-side
 * filter emitter (src/compile/emit-filter.ts) models `with:` as an OR
 * across address fields (from/to/cc/bcc/deliveredTo), verified against
 * live Rule/get output — that is what the INSTALLED delivery-time rule
 * matches. Email/query has no equivalent address-fields condition
 * exposed here, so this renderer approximates those leaves as a
 * full-text `{text}` match. Counts for `anywhere`/`with:` rules from
 * verify/apply can therefore diverge from delivery-time behavior.
 */

import type { Condition, PredicateLeaf, When } from '../types.ts';
import { nextUtcMidnightIso, utcMidnightIso } from '../util/dates.ts';

export interface RenderedFilter {
  /** Structured condition for Email/query, or null for match-everything. */
  condition: unknown;
  /** Leaf descriptions the server cannot evaluate (e.g. VIP membership). */
  unsupported: string[];
}

function renderAddressValue(match: string, value: string): string {
  // emit.ts renders `domain` and `domain_or_subdomain` with an "@" prefix;
  // the same value works for the structured from/to/… conditions.
  if (match === 'domain' || match === 'domain_or_subdomain') return `@${value}`;
  return value;
}

function renderPredicate(leaf: PredicateLeaf, out: RenderedFilter): unknown {
  switch (leaf.kind) {
    case 'priority':
      return { isHighPriority: true };
    case 'has_attachment':
      return { hasAttachment: true };
    case 'has_list_id':
      // Fastmail exposes no "any List-Id present" filter condition; the
      // header-exists form is the faithful equivalent.
      return { header: ['List-Id'] };
    case 'from_in_contacts':
      return { fromAnyContact: true };
    case 'to_in_contacts':
      // Mirrors the web client's expansion of toin:contacts.
      return {
        operator: 'OR',
        conditions: [{ toAnyContact: true }, { ccAnyContact: true }, { bccAnyContact: true }],
      };
    case 'from_in_vips':
      out.unsupported.push('from_in_vips (no server-side filter for VIP senders)');
      return null;
    case 'to_in_vips':
      out.unsupported.push('to_in_vips (no server-side filter for VIP recipients)');
      return null;
    case 'from_in_group':
      out.unsupported.push(`from_in_group "${leaf.group}" (requires contact-card UID lookup)`);
      return null;
    case 'to_in_group':
      out.unsupported.push(`to_in_group "${leaf.group}" (requires contact-card UID lookup)`);
      return null;
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
      // Web-client parity: mimetype: is passed to the text filter as-is.
      return { text: `mimetype:${leaf.value}` };
  }
}

function renderLeaf(node: Condition, out: RenderedFilter): unknown {
  switch (node.kind) {
    case 'phrase':
      switch (node.field) {
        case 'subject':
          return { subject: node.value };
        case 'body':
          return { body: node.value };
        case 'anywhere':
          // Full-text approximation — see the divergence caveat in the
          // module header; the installed rule matches address fields only.
          return { text: node.value };
        case 'attachment_name':
          return { hasAttachment: true, attachmentName: node.value };
      }
      break; // unreachable
    case 'address': {
      const value = renderAddressValue(node.match, node.value);
      switch (node.field) {
        case 'from':
          return { from: value };
        case 'to':
          // §8.3: Fastmail's to: covers To, Cc, Bcc and DeliveredTo.
          return {
            operator: 'OR',
            conditions: [{ to: value }, { cc: value }, { bcc: value }, { deliveredTo: value }],
          };
        case 'to_only':
          return { to: value };
        case 'cc':
          return { cc: value };
        case 'bcc':
          return { bcc: value };
        case 'delivered_to':
          return { deliveredTo: value };
      }
      break; // unreachable
    }
    case 'list_id': {
      // The server rejects a `listId` filter condition outright (observed
      // live), so anchor on the List-Id header instead. Angle brackets
      // make the substring match exact for practical purposes — List-Id
      // values are conventionally "<bare>" with nothing else.
      const bare = node.value.replace(/^<+/, '').replace(/>+$/, '');
      return { header: ['List-Id', `<${bare}>`] };
    }
    case 'size':
      return node.op === 'larger_than' ? { minSize: node.bytes } : { maxSize: node.bytes };
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
      return renderPredicate(node, out);
    case 'header_exists':
      return { header: [node.name] };
    case 'header_equals':
    case 'header_contains':
    case 'header_prefix':
    case 'header_suffix':
      // The structured header condition is a substring match (same
      // operator-collapse emit.ts documents for the search dialect).
      return { header: [node.name, node.value] };
    case 'date': {
      const conditions: unknown[] = [];
      if (node.equals) {
        conditions.push({ after: utcMidnightIso(node.equals) }, { before: nextUtcMidnightIso(node.equals) });
      }
      if (node.after) conditions.push({ after: utcMidnightIso(node.after) });
      if (node.before) conditions.push({ before: utcMidnightIso(node.before) });
      return conditions.length === 1 ? conditions[0] : { operator: 'AND', conditions };
    }
    case 'raw':
      // Full-text pass-through. For `with:` values this diverges from the
      // installed rule's address-fields OR — see the module header caveat.
      return { text: node.value };
    default:
      break;
  }
  return null;
}

/**
 * Render a condition tree. `null` means "matches everything" (e.g.
 * `when: always` or an empty all/any group).
 */
export function renderFilter(when: When, resolved: Condition | null): RenderedFilter {
  const out: RenderedFilter = { condition: null, unsupported: [] };
  if (when.kind === 'always') return out;
  if (!resolved) return out;
  out.condition = renderNode(resolved, out);
  return out;
}

function renderNode(node: Condition, out: RenderedFilter): unknown {
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
      throw new Error('renderFilter called on unresolved extends (internal error)');
    default:
      return renderLeaf(node, out);
  }
}
