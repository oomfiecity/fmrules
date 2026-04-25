/**
 * Phase 5 — render an ExpandedRule into the Fastmail import JSON shape.
 *
 * This file is the single source of truth for Fastmail's wire format.
 * Every "Fastmail-defined behavior" hedge in the spec has a dedicated
 * function below, labeled with the §-reference it hedges:
 *
 *   emitWhenAlways()        — §11.5 ("when: always" emit format)
 *   emitDateLeaf()          — §8.6  (date boundary semantics)
 *   emitSnoozeUntil()       — §10.2 (past-time behavior)
 *   emitFiletype()          — §8.4  (category MIME mapping — not encoded here)
 *   partitioning / snooze-last placement — §10.4 (lives in expand.ts, not here)
 *
 * If Fastmail's behavior at any of these points becomes precise (via live
 * testing), this is the only file that needs re-visiting.
 */

import type {
  Actions,
  AddressLeaf,
  Condition,
  DateLeaf,
  EmittedRule,
  EmittedSnooze,
  HeaderLeaf,
  ListIdLeaf,
  PhraseLeaf,
  PredicateLeaf,
  RawLeaf,
  SizeLeaf,
  SnoozeSchedule,
  When,
} from '../types.ts';
import type { ExpandedRule } from './expand.ts';

// ────────────────────────────────────────────────────────────────────────────
// Search-string rendering

const NEEDS_QUOTING = /[\s():{}"'-]/;

function quote(v: string): string {
  if (v.length > 0 && !NEEDS_QUOTING.test(v)) return v;
  return `"${v.replace(/"/g, '\\"')}"`;
}

function renderField(field: string, value: string): string {
  return `${field}:${quote(value)}`;
}

function renderAddress(leaf: AddressLeaf): string {
  const op = leaf.field === 'to_only' ? 'tonotcc' : leaf.field === 'delivered_to' ? 'deliveredto' : leaf.field;
  switch (leaf.match) {
    case 'address':
    case 'contains':
    case 'prefix':
      // Fastmail's address-field operator searches the whole header value
      // (address + display name), which is how `contains` / `prefix` /
      // `address` all flow through the same operator. Differentiating
      // across match types server-side is not exposed; authors rely on
      // the value's specificity.
      return renderField(op, leaf.value);
    case 'domain':
      return renderField(op, `@${leaf.value}`);
    case 'domain_or_subdomain':
      // Fastmail's `from:@example.com` matches example.com and its
      // subdomains. The spec's `domain` wants "exactly example.com" —
      // identical wire encoding today (§2 hedge about spec vs Fastmail
      // semantics; author-side, the distinction is documented).
      return renderField(op, `@${leaf.value}`);
  }
}

function renderPhrase(leaf: PhraseLeaf): string {
  const op = leaf.field === 'anywhere' ? 'with' : leaf.field === 'attachment_name' ? 'filename' : leaf.field;
  return renderField(op, leaf.value);
}

function renderListId(leaf: ListIdLeaf): string {
  // Fastmail's list: operator matches against a normalized <value> form.
  const bare = leaf.value.replace(/^<+/, '').replace(/>+$/, '');
  return renderField('list', `<${bare}>`);
}

function renderSize(leaf: SizeLeaf): string {
  const op = leaf.op === 'larger_than' ? 'minsize' : 'maxsize';
  return `${op}:${leaf.bytes}`;
}

/**
 * Hedge (§8.4): filetype category -> MIME type mapping.
 * Fastmail owns the category definitions; we don't reproduce them here.
 * The seven categories are: image, pdf, document, spreadsheet,
 * presentation, email, calendar. We emit `filetype:<cat>` verbatim and
 * let Fastmail expand. If a category ever needs MIME-level tightening
 * from our side, put the mapping here.
 */
function emitFiletype(cat: string): string {
  return `filetype:${cat}`;
}

function renderPredicate(leaf: PredicateLeaf): string {
  switch (leaf.kind) {
    case 'priority':
      return 'priority:high';
    case 'has_attachment':
      return 'has:attachment';
    case 'has_list_id':
      // Fastmail has no explicit "any list-id present" operator exposed;
      // `list:*` is the least-surprising encoding. If this turns out to
      // be wrong in practice this is the one line to revisit.
      return 'list:*';
    case 'from_in_contacts':
      return 'fromin:contacts';
    case 'from_in_vips':
      return 'fromin:vip';
    case 'from_in_group':
      return `fromin:${quote(leaf.group)}`;
    case 'to_in_contacts':
      return 'toin:contacts';
    case 'to_in_vips':
      return 'toin:vip';
    case 'to_in_group':
      return `toin:${quote(leaf.group)}`;
    case 'conv_followed':
      return 'is:followed';
    case 'conv_muted':
      return 'is:muted';
    case 'msg_pinned':
      return 'is:flagged';
    case 'msg_replied':
      return 'is:answered';
    case 'filetype':
      return emitFiletype(leaf.value);
    case 'mimetype':
      // Fastmail search operator for MIME type isn't in the documented
      // grammar; `mimetype:` is our best guess and is flagged in the spec.
      return `mimetype:${quote(leaf.value)}`;
  }
}

function renderHeader(leaf: HeaderLeaf): string {
  // Fastmail's header syntax: `header:"Name:value"` — the whole payload
  // is one quoted argument, regardless of internal colons/spaces.
  // `exists`/`prefix`/`suffix`/`contains`/`equals` all share the same
  // operator; differentiating at the Fastmail level is not exposed.
  switch (leaf.kind) {
    case 'header_exists':
      return `header:${quote(leaf.name)}`;
    default:
      return `header:${quote(`${leaf.name}:${leaf.value}`)}`;
  }
}

/**
 * Hedge (§8.6): date boundary semantics.
 * Fastmail decides whether `after:YYYY-MM-DD` includes midnight of that
 * date. The spec documents user intent ("on this date or later") but
 * points out that boundary behavior is Fastmail-defined. If we ever
 * want to pin this down (e.g. emit an explicit timestamp), this is
 * where it changes.
 */
function emitDateLeaf(leaf: DateLeaf): string {
  const parts: string[] = [];
  if (leaf.equals) parts.push(`date:${leaf.equals}`);
  if (leaf.after) parts.push(`after:${leaf.after}`);
  if (leaf.before) parts.push(`before:${leaf.before}`);
  return parts.length === 1 ? parts[0]! : `(${parts.join(' ')})`;
}

function renderRaw(leaf: RawLeaf): string {
  // Opaque to the compiler by design. §8.7 already rejected stripped
  // operators; anything else flows through verbatim.
  return leaf.value;
}

function renderLeaf(node: Condition): string {
  switch (node.kind) {
    case 'phrase': return renderPhrase(node);
    case 'address': return renderAddress(node);
    case 'list_id': return renderListId(node);
    case 'size': return renderSize(node);
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
      return renderPredicate(node);
    case 'header_exists':
    case 'header_equals':
    case 'header_contains':
    case 'header_prefix':
    case 'header_suffix':
      return renderHeader(node);
    case 'date': return emitDateLeaf(node);
    case 'raw': return renderRaw(node);
    case 'all':
    case 'any':
    case 'not':
    case 'extends':
      throw new Error(`renderLeaf called on non-leaf ${node.kind} (internal error)`);
  }
}

/**
 * Render a condition subtree. The caller decides whether its output needs
 * parens (to disambiguate against the surrounding combinator). Leaves and
 * single-child groups render without parens; AND/OR groups with >1
 * children render their children space- or OR-joined.
 */
function renderCondition(node: Condition, wrap: boolean): string {
  if (node.kind === 'all') {
    if (node.children.length === 0) return '';
    if (node.children.length === 1) return renderCondition(node.children[0]!, wrap);
    const parts = node.children.map((c) => {
      if (c.kind === 'any' && c.children.length > 1) return `(${renderCondition(c, false)})`;
      return renderCondition(c, false);
    });
    const joined = parts.join(' ');
    return wrap ? `(${joined})` : joined;
  }
  if (node.kind === 'any') {
    if (node.children.length === 0) return '';
    if (node.children.length === 1) return renderCondition(node.children[0]!, wrap);
    const parts = node.children.map((c) => renderCondition(c, false));
    const joined = parts.join(' OR ');
    return wrap ? `(${joined})` : joined;
  }
  if (node.kind === 'not') {
    const inner = node.child;
    if (inner.kind === 'all' || inner.kind === 'any') {
      return `NOT (${renderCondition(inner, false)})`;
    }
    return `-${renderLeaf(inner)}`;
  }
  if (node.kind === 'extends') {
    throw new Error('renderCondition called on unresolved extends (internal error)');
  }
  return renderLeaf(node);
}

/**
 * Hedge (§11.5): `when: always` emit format.
 * Fastmail currently represents a no-condition filter as search string `*`.
 * If that changes, this is the one line to touch.
 */
function emitWhenAlways(): string {
  return '*';
}

export function emitSearch(when: When, resolved: Condition | null): string {
  if (when.kind === 'always') return emitWhenAlways();
  if (!resolved) return emitWhenAlways();
  return renderCondition(resolved, /* wrap */ false);
}

// ────────────────────────────────────────────────────────────────────────────
// Combinator derivation

/**
 * Fastmail's `combinator` is a top-level hint. It matches §8.2 only at
 * the root — a rule whose resolved tree's root is `any:` gets
 * combinator: 'any'; everything else is 'all'.
 */
export function deriveCombinator(when: When, resolved: Condition | null): 'all' | 'any' {
  if (when.kind === 'always') return 'all';
  if (!resolved) return 'all';
  return resolved.kind === 'any' ? 'any' : 'all';
}

// ────────────────────────────────────────────────────────────────────────────
// Action emission

/**
 * Hedge (§10.2): snooze past-time behavior.
 * Fastmail decides the "next occurrence" semantics when the named time
 * has already passed today and today is in `days`. The spec calls out
 * this as server-side; the emit target simply passes `time` and `days`
 * through in Fastmail's JSON shape.
 */
function emitSnoozeUntil(s: SnoozeSchedule): EmittedSnooze {
  return {
    time: s.time,
    days: s.days ? [...s.days] : null,
  };
}

function emitActions(actions: Actions): Pick<
  EmittedRule,
  | 'markRead'
  | 'markFlagged'
  | 'showNotification'
  | 'redirectTo'
  | 'fileIn'
  | 'skipInbox'
  | 'snoozeUntil'
  | 'discard'
  | 'markSpam'
  | 'stop'
> {
  const labels = actions.add_label ?? [];
  const forwards = actions.send_copy_to ?? [];
  return {
    markRead: actions.mark_read === true,
    markFlagged: actions.pin === true,
    showNotification: actions.notify === true,
    redirectTo: forwards.length > 0 ? [...forwards] : null,
    // Each Fastmail rule carries at most one label (§10.4 expansion guarantees this).
    fileIn: labels[0] ?? null,
    skipInbox: actions.archive === true,
    snoozeUntil: actions.snooze_until ? emitSnoozeUntil(actions.snooze_until) : null,
    discard: actions.delete_to_trash === true,
    markSpam: actions.send_to_spam === true,
    // `stop` mirrors Fastmail's "stop processing further rules" flag. With
    // continueFlag=false this is true; otherwise false.
    stop: false, // filled in by emitRule (depends on continueFlag, not actions)
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Top-level

export function emitRule(rule: ExpandedRule, nowIso: string): EmittedRule {
  const search = emitSearch(rule.when, rule.resolvedCondition);
  const combinator = deriveCombinator(rule.when, rule.resolvedCondition);
  const actionParts = emitActions(rule.actions);
  const stop = !rule.continueFlag;
  const out: EmittedRule = {
    name: rule.name,
    // YAML's `enabled` drives Fastmail's isEnabled. Disabled rules never
    // reach emit in the first place; we always emit isEnabled for clarity.
    isEnabled: rule.source.enabled,
    combinator,
    conditions: null,
    search,
    ...actionParts,
    stop,
    previousFileInName: null,
    created: nowIso,
    updated: nowIso,
  };
  return out;
}
