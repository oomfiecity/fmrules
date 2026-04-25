/**
 * Phase 2 — parse raw YAML values into typed structures and enforce every
 * SPEC(10).md §12 check that does not require cross-file resolution.
 *
 * One module per file role:
 *   - buildRuleFile(raw) — §6, §10, most of §12.2
 *   - buildSnippetFile(raw) — §7, §12.3
 *   - parseCondition / parseLeaf — §8, §12.4
 *
 * A parse failure at any point pushes an error AND returns a sentinel
 * (null or a marker) so the caller can skip the subtree. The parser is
 * lenient in the sense that it keeps going after one error, reporting
 * as many distinct problems as it can in one pass.
 */

import path from 'node:path';
import type {
  Actions,
  AddressLeaf,
  AddressMatchType,
  Condition,
  DateLeaf,
  FileType,
  HeaderLeaf,
  HeaderMatchType,
  Leaf,
  ListIdLeaf,
  PhraseLeaf,
  PhraseMatchType,
  PredicateLeaf,
  RawLeaf,
  Rule,
  RuleFile,
  SizeLeaf,
  SnippetFile,
  SnoozeSchedule,
  Weekday,
  When,
} from '../types.ts';
import type { ErrorCollector } from './errors.ts';
import type { RawFile } from './load.ts';
import { scanStrippedOperators } from './raw-scan.ts';

// ────────────────────────────────────────────────────────────────────────────
// Helpers

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface Ctx {
  file: string;
  /** Breadcrumb path inside the file, e.g. `rules[0].when.all[2]`. */
  loc: string;
  errors: ErrorCollector;
}

function sub(ctx: Ctx, segment: string): Ctx {
  return { ...ctx, loc: ctx.loc === '' ? segment : `${ctx.loc}.${segment}` };
}

function err(ctx: Ctx, tag: string, message: string): void {
  ctx.errors.error({
    file: ctx.file,
    tag,
    message: ctx.loc ? `${ctx.loc}: ${message}` : message,
  });
}

// Set of all recognized action keys — anything else is an unknown key.
const ACTION_KEYS = new Set([
  'mark_read',
  'pin',
  'notify',
  'add_label',
  'archive',
  'send_copy_to',
  'snooze_until',
  'delete_to_trash',
  'send_to_spam',
]);

const TERMINAL_ACTIONS = new Set(['archive', 'delete_to_trash', 'send_to_spam']);

// Recognized condition keys — combinator + leaf types.
const COMBINATOR_KEYS = new Set(['all', 'any', 'not']);
const LEAF_KEYS = new Set([
  'from',
  'to',
  'to_only',
  'cc',
  'bcc',
  'delivered_to',
  'subject',
  'body',
  'anywhere',
  'attachment_name',
  'list_id',
  'priority',
  'has_attachment',
  'has_list_id',
  'from_in_contacts',
  'from_in_vips',
  'from_in_group',
  'to_in_contacts',
  'to_in_vips',
  'to_in_group',
  'conv_followed',
  'conv_muted',
  'msg_pinned',
  'msg_replied',
  'larger_than',
  'smaller_than',
  'filetype',
  'mimetype',
  'header',
  'date',
  'raw',
  'extends',
]);

const ADDRESS_FIELDS = new Set(['from', 'to', 'to_only', 'cc', 'bcc', 'delivered_to']);
const PHRASE_FIELDS = new Set(['subject', 'body', 'anywhere', 'attachment_name']);

const ADDRESS_MATCH_TYPES = new Set<AddressMatchType>([
  'contains',
  'prefix',
  'address',
  'domain',
  'domain_or_subdomain',
]);

const PHRASE_MATCH_TYPES = new Set<PhraseMatchType>(['contains', 'equals', 'prefix']);

const HEADER_MATCH_TYPES = new Set<HeaderMatchType>([
  'exists',
  'equals',
  'contains',
  'prefix',
  'suffix',
]);

const FILETYPE_VALUES = new Set<FileType>([
  'image',
  'pdf',
  'document',
  'spreadsheet',
  'presentation',
  'email',
  'calendar',
]);

const WEEKDAY_VALUES = new Set<Weekday>(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RELATIVE_DATE_RE = /^\d+[dwmy]$/;

const NAME_CONTROL_RE = /[\u0000-\u001F\u007F]/;

// ────────────────────────────────────────────────────────────────────────────
// Size parsing (§8.4)

/** Parse a size string into bytes. Returns null and pushes an error on failure. */
function parseSize(ctx: Ctx, input: unknown): number | null {
  if (typeof input !== 'string') {
    err(ctx, '12.4', `size must be a string (got ${typeof input}).`);
    return null;
  }
  const raw = input;
  // Grammar: digits[.digits]? then optional whitespace then optional unit.
  const match = raw.match(/^\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]*)\s*$/);
  if (!match) {
    err(ctx, '12.4', `unparseable size "${raw}" (expected e.g. "10MB", "500KB", "10 MB").`);
    return null;
  }
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num < 0) {
    err(ctx, '12.4', `size "${raw}" must be non-negative.`);
    return null;
  }
  const unit = (match[2] ?? '').toUpperCase();
  const mult =
    unit === '' || unit === 'B' ? 1 :
    unit === 'KB' ? 1024 :
    unit === 'MB' ? 1024 * 1024 :
    unit === 'GB' ? 1024 * 1024 * 1024 :
    null;
  if (mult === null) {
    err(ctx, '12.4', `unrecognized unit "${unit}" in size "${raw}" (use B, KB, MB, or GB).`);
    return null;
  }
  return Math.floor(num * mult);
}

// ────────────────────────────────────────────────────────────────────────────
// Match-type dictionary parsing (phrase / address / list_id)

function parsePhraseMatch(ctx: Ctx, field: PhraseLeaf['field'], v: unknown): PhraseLeaf | null {
  if (!isPlainObject(v)) {
    err(ctx, '12.4', `${field}: must be a dictionary with a match type (contains/equals/prefix).`);
    return null;
  }
  const keys = Object.keys(v);
  if (keys.length !== 1) {
    err(ctx, '12.4', `${field}: exactly one match type required (got ${keys.length}: ${keys.join(', ')}).`);
    return null;
  }
  const mt = keys[0]!;
  if (!PHRASE_MATCH_TYPES.has(mt as PhraseMatchType)) {
    err(ctx, '12.4', `${field}: unknown match type "${mt}" (allowed: ${Array.from(PHRASE_MATCH_TYPES).join(', ')}).`);
    return null;
  }
  const val = v[mt];
  if (typeof val !== 'string') {
    err(ctx, '12.4', `${field}.${mt}: value must be a string.`);
    return null;
  }
  return { kind: 'phrase', field, match: mt as PhraseMatchType, value: val };
}

function parseAddressMatch(ctx: Ctx, field: AddressLeaf['field'], v: unknown): AddressLeaf | null {
  if (!isPlainObject(v)) {
    err(ctx, '12.4', `${field}: must be a dictionary with a match type.`);
    return null;
  }
  const keys = Object.keys(v);
  if (keys.length !== 1) {
    err(ctx, '12.4', `${field}: exactly one match type required (got ${keys.length}: ${keys.join(', ')}).`);
    return null;
  }
  const mt = keys[0]!;
  if (mt === 'equals') {
    err(ctx, '12.4', `${field}: address fields do not accept 'equals' — use 'address' for exact email, or 'contains' for display-name match.`);
    return null;
  }
  if (!ADDRESS_MATCH_TYPES.has(mt as AddressMatchType)) {
    err(ctx, '12.4', `${field}: unknown match type "${mt}" (allowed: ${Array.from(ADDRESS_MATCH_TYPES).join(', ')}).`);
    return null;
  }
  const val = v[mt];
  if (typeof val !== 'string' || val === '') {
    err(ctx, '12.4', `${field}.${mt}: value must be a non-empty string.`);
    return null;
  }
  return { kind: 'address', field, match: mt as AddressMatchType, value: val };
}

function parseListId(ctx: Ctx, v: unknown): ListIdLeaf | null {
  if (!isPlainObject(v)) {
    err(ctx, '12.4', `list_id: must be a dictionary { equals: "..." }.`);
    return null;
  }
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== 'equals') {
    err(ctx, '12.4', `list_id: only 'equals' is supported (got ${keys.join(', ')}).`);
    return null;
  }
  const val = v.equals;
  if (typeof val !== 'string' || val === '') {
    err(ctx, '12.4', `list_id.equals: value must be a non-empty string.`);
    return null;
  }
  return { kind: 'list_id', value: val };
}

// ────────────────────────────────────────────────────────────────────────────
// Predicate leaves (§8.4)

function parsePredicate(ctx: Ctx, key: string, v: unknown): PredicateLeaf | null {
  switch (key) {
    case 'priority':
      if (typeof v !== 'string') {
        err(ctx, '12.4', `priority: value must be the string 'high'.`);
        return null;
      }
      if (v !== v.toLowerCase()) {
        err(ctx, '12.4', `priority: enum values must be lowercase (got "${v}").`);
        return null;
      }
      if (v !== 'high') {
        err(ctx, '12.4', `priority: only 'high' is supported (got "${v}").`);
        return null;
      }
      return { kind: 'priority', value: 'high' };

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
      if (v !== true) {
        err(ctx, '12.4', `${key}: boolean predicates take value 'true' only. To negate, wrap in not:.`);
        return null;
      }
      return { kind: key } as PredicateLeaf;

    case 'from_in_group':
    case 'to_in_group':
      if (typeof v !== 'string' || v === '') {
        err(ctx, '12.4', `${key}: value must be a non-empty group name.`);
        return null;
      }
      return { kind: key, group: v } as PredicateLeaf;

    case 'filetype': {
      if (typeof v !== 'string') {
        err(ctx, '12.4', `filetype: value must be a string (one of ${Array.from(FILETYPE_VALUES).join(', ')}).`);
        return null;
      }
      if (v !== v.toLowerCase()) {
        err(ctx, '12.4', `filetype: enum values must be lowercase (got "${v}").`);
        return null;
      }
      if (!FILETYPE_VALUES.has(v as FileType)) {
        err(ctx, '12.4', `filetype: unknown value "${v}" (allowed: ${Array.from(FILETYPE_VALUES).join(', ')}).`);
        return null;
      }
      return { kind: 'filetype', value: v as FileType };
    }

    case 'mimetype':
      if (typeof v !== 'string' || v === '') {
        err(ctx, '12.4', `mimetype: value must be a non-empty string (e.g. "application/pdf").`);
        return null;
      }
      return { kind: 'mimetype', value: v };

    default:
      err(ctx, '12.4', `internal: predicate "${key}" not handled.`);
      return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Header leaf (§8.5)

function parseHeader(ctx: Ctx, v: unknown): HeaderLeaf | null {
  if (!isPlainObject(v)) {
    err(ctx, '12.4', `header: must be a dictionary with 'name' and exactly one match type.`);
    return null;
  }
  const { name, ...rest } = v as Record<string, unknown>;
  if (typeof name !== 'string' || name === '') {
    err(ctx, '12.4', `header.name: must be a non-empty string.`);
    return null;
  }
  const mtKeys = Object.keys(rest);
  if (mtKeys.length !== 1) {
    err(ctx, '12.4', `header: exactly one match type required besides 'name' (got ${mtKeys.length}: ${mtKeys.join(', ')}).`);
    return null;
  }
  const mt = mtKeys[0]!;
  if (!HEADER_MATCH_TYPES.has(mt as HeaderMatchType)) {
    err(ctx, '12.4', `header: unknown match type "${mt}" (allowed: ${Array.from(HEADER_MATCH_TYPES).join(', ')}).`);
    return null;
  }
  const mtVal = rest[mt];
  if (mt === 'exists') {
    if (mtVal !== true) {
      err(ctx, '12.4', `header.exists: takes value 'true' only. To negate, wrap in not:.`);
      return null;
    }
    return { kind: 'header_exists', name };
  }
  if (typeof mtVal !== 'string') {
    err(ctx, '12.4', `header.${mt}: value must be a string.`);
    return null;
  }
  return { kind: `header_${mt}`, name, value: mtVal } as HeaderLeaf;
}

// ────────────────────────────────────────────────────────────────────────────
// Date leaf (§8.6)

function parseDate(ctx: Ctx, v: unknown): DateLeaf | null {
  if (!isPlainObject(v)) {
    err(ctx, '12.4', `date: must be a dictionary with any of after/before/equals.`);
    return null;
  }
  const allowed = new Set(['after', 'before', 'equals']);
  for (const k of Object.keys(v)) {
    if (!allowed.has(k)) {
      err(ctx, '12.4', `date: unknown key "${k}" (allowed: after, before, equals).`);
    }
  }
  const entries: [string, string][] = [];
  for (const k of ['after', 'before', 'equals']) {
    if (!(k in v)) continue;
    const val = v[k];
    if (typeof val !== 'string') {
      err(ctx, '12.4', `date.${k}: must be a string in YYYY-MM-DD.`);
      continue;
    }
    if (RELATIVE_DATE_RE.test(val)) {
      err(ctx, '12.4', `date.${k}: relative values are not supported. Use an absolute YYYY-MM-DD instead (see §2).`);
      continue;
    }
    if (!DATE_RE.test(val)) {
      err(ctx, '12.4', `date.${k}: "${val}" is not a valid absolute YYYY-MM-DD date.`);
      continue;
    }
    // Full date validity (e.g. reject 2025-13-40)
    const [y, m, d] = val.split('-').map(Number) as [number, number, number];
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (
      probe.getUTCFullYear() !== y ||
      probe.getUTCMonth() !== m - 1 ||
      probe.getUTCDate() !== d
    ) {
      err(ctx, '12.4', `date.${k}: "${val}" is not a valid calendar date.`);
      continue;
    }
    entries.push([k, val]);
  }

  if (entries.length === 0) {
    err(ctx, '12.4', `date: at least one of after/before/equals is required.`);
    return null;
  }
  const keys = new Set(entries.map((e) => e[0]));
  if (keys.has('equals') && (keys.has('after') || keys.has('before'))) {
    err(ctx, '12.4', `date: 'equals' cannot be combined with 'after' or 'before'.`);
    return null;
  }
  const after = entries.find((e) => e[0] === 'after')?.[1];
  const before = entries.find((e) => e[0] === 'before')?.[1];
  const equals = entries.find((e) => e[0] === 'equals')?.[1];
  if (after && before && after > before) {
    err(ctx, '12.4', `date: range inverted — after (${after}) is later than before (${before}).`);
    return null;
  }
  return { kind: 'date', after, before, equals };
}

// ────────────────────────────────────────────────────────────────────────────
// raw: leaf (§8.7)

function parseRawLeaf(ctx: Ctx, v: unknown): RawLeaf | null {
  if (typeof v !== 'string' || v === '') {
    err(ctx, '12.6', `raw: value must be a non-empty string.`);
    return null;
  }
  const hits = scanStrippedOperators(v);
  if (hits.length > 0) {
    const list = hits.map((h) => `"${h.token}"`).join(', ');
    err(
      ctx,
      '12.6',
      `raw: value contains operator(s) Fastmail strips from rule filters: ${list}. These are rejected per §8.7 — Fastmail would not honor them. No bypass is available.`,
    );
    return null;
  }
  return { kind: 'raw', value: v };
}

// ────────────────────────────────────────────────────────────────────────────
// Combinator / extends (§8.2, §9)

export interface ParseConditionOptions {
  /** When false, `extends:` at this level is a compile error (used inside snippets). */
  allowExtends: boolean;
}

function parseExtends(ctx: Ctx, v: unknown): Condition | null {
  if (!Array.isArray(v)) {
    err(ctx, '12.5', `extends: value must be a list of snippet paths.`);
    return null;
  }
  if (v.length === 0) {
    err(ctx, '12.5', `extends: list must not be empty.`);
    return null;
  }
  const paths: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < v.length; i++) {
    const p = v[i];
    if (typeof p !== 'string') {
      err(ctx, '12.5', `extends[${i}]: path must be a string.`);
      continue;
    }
    if (p.includes('\\')) {
      err(ctx, '12.5', `extends[${i}]: paths must use forward slashes ("${p}").`);
      continue;
    }
    if (!p.startsWith('snippets/')) {
      err(ctx, '12.5', `extends[${i}]: "${p}" must be under snippets/.`);
      continue;
    }
    if (!p.endsWith('.yml')) {
      err(ctx, '12.5', `extends[${i}]: "${p}" must end in .yml.`);
      continue;
    }
    if (seen.has(p)) {
      err(ctx, '12.5', `extends[${i}]: "${p}" appears more than once in the list.`);
      continue;
    }
    seen.add(p);
    paths.push(p);
  }
  if (paths.length === 0) return null;
  return { kind: 'extends', paths };
}

export function parseCondition(
  ctx: Ctx,
  v: unknown,
  opts: ParseConditionOptions,
): Condition | null {
  if (!isPlainObject(v)) {
    err(ctx, '12.4', `condition must be a mapping, got ${Array.isArray(v) ? 'list' : typeof v}.`);
    return null;
  }
  const keys = Object.keys(v);
  if (keys.length === 0) {
    err(ctx, '12.4', `condition is empty.`);
    return null;
  }
  if (keys.length > 1) {
    err(ctx, '12.4', `condition must have exactly one key (got ${keys.length}: ${keys.join(', ')}).`);
    return null;
  }
  const key = keys[0]!;
  const val = v[key];

  // Reject stray `always` inside combinators.
  if (key === 'always') {
    err(ctx, '12.4', `\`always\` is only valid at the root of \`when:\`, not inside a condition tree.`);
    return null;
  }

  if (COMBINATOR_KEYS.has(key)) {
    if (key === 'all' || key === 'any') {
      if (!Array.isArray(val)) {
        err(ctx, '12.4', `${key}: must be a list of conditions.`);
        return null;
      }
      if (val.length === 0) {
        err(ctx, '12.4', `${key}: list must not be empty.`);
        return null;
      }
      const children: Condition[] = [];
      for (let i = 0; i < val.length; i++) {
        const child = parseCondition(sub(ctx, `${key}[${i}]`), val[i], opts);
        if (child) children.push(child);
      }
      return { kind: key, children };
    }
    // not:
    if (Array.isArray(val)) {
      err(ctx, '12.4', `not: takes a single condition group, not a list. Wrap in all: or any: explicitly.`);
      return null;
    }
    if (!isPlainObject(val)) {
      err(ctx, '12.4', `not: must wrap a condition group.`);
      return null;
    }
    const innerKeys = Object.keys(val);
    if (innerKeys.length > 1) {
      err(ctx, '12.4', `not: wraps multiple conditions — wrap them in all: or any: explicitly.`);
      return null;
    }
    // §9: extends inside not: is restricted to one snippet.
    if (opts.allowExtends && innerKeys[0] === 'extends') {
      const inner = val.extends;
      if (Array.isArray(inner) && inner.length > 1) {
        err(ctx, '12.5', `not: extends with more than one snippet is ambiguous — wrap in an explicit all: or any: first.`);
        return null;
      }
    }
    const child = parseCondition(sub(ctx, 'not'), val, opts);
    if (!child) return null;
    return { kind: 'not', child };
  }

  if (key === 'extends') {
    if (!opts.allowExtends) {
      err(ctx, '12.5', `extends: not permitted here (snippets cannot extend other snippets).`);
      return null;
    }
    return parseExtends(sub(ctx, 'extends'), val);
  }

  return parseLeaf(sub(ctx, key), key, val);
}

function parseLeaf(ctx: Ctx, key: string, val: unknown): Leaf | null {
  if (ADDRESS_FIELDS.has(key)) {
    return parseAddressMatch(ctx, key as AddressLeaf['field'], val);
  }
  if (PHRASE_FIELDS.has(key)) {
    return parsePhraseMatch(ctx, key as PhraseLeaf['field'], val);
  }
  if (key === 'list_id') return parseListId(ctx, val);
  if (key === 'header') return parseHeader(ctx, val);
  if (key === 'date') return parseDate(ctx, val);
  if (key === 'raw') return parseRawLeaf(ctx, val);
  if (key === 'larger_than' || key === 'smaller_than') {
    const raw = typeof val === 'string' ? val : String(val);
    const bytes = parseSize(ctx, val);
    if (bytes === null) return null;
    return { kind: 'size', op: key, bytes, raw } as SizeLeaf;
  }
  if (LEAF_KEYS.has(key)) {
    return parsePredicate(ctx, key, val);
  }
  err(ctx, '12.4', `unknown condition field "${key}".`);
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// `when:` root (§6, §8.1)

function parseWhen(ctx: Ctx, v: unknown): When | null {
  if (v === 'always') return { kind: 'always' };
  if (typeof v === 'string') {
    err(ctx, '12.2', `when: string value "${v}" is not recognized. The only bare value allowed is \`always\`.`);
    return null;
  }
  if (!isPlainObject(v)) {
    err(ctx, '12.2', `when: must be a condition group (all/any/not) or the bare value \`always\`.`);
    return null;
  }
  return parseCondition(ctx, v, { allowExtends: true });
}

// ────────────────────────────────────────────────────────────────────────────
// Actions (§10, §12.2)

function validateLabelPath(ctx: Ctx, p: unknown, where: string): string | null {
  if (typeof p !== 'string') {
    err(ctx, '12.2', `${where}: value must be a string.`);
    return null;
  }
  if (p === '') {
    err(ctx, '12.2', `${where}: value must not be empty.`);
    return null;
  }
  if (p !== p.trim()) {
    err(ctx, '12.2', `${where}: value "${p}" must not have leading/trailing whitespace.`);
    return null;
  }
  if (p.startsWith('/') || p.endsWith('/')) {
    err(ctx, '12.2', `${where}: value "${p}" must not have a leading or trailing '/'.`);
    return null;
  }
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s.trim() === '') {
      err(ctx, '12.2', `${where}: value "${p}" contains empty or whitespace-only path segments.`);
      return null;
    }
  }
  return p;
}

function parseSnooze(ctx: Ctx, v: unknown): SnoozeSchedule | null {
  if (!isPlainObject(v)) {
    err(ctx, '12.2', `snooze_until: must be a dictionary with 'time' and optional 'days'.`);
    return null;
  }
  for (const k of Object.keys(v)) {
    if (k !== 'time' && k !== 'days') {
      err(ctx, '12.2', `snooze_until: unknown key "${k}" (allowed: time, days).`);
    }
  }
  const time = v.time;
  if (typeof time !== 'string' || !/^\d{2}:\d{2}$/.test(time)) {
    err(ctx, '12.2', `snooze_until.time: must be exactly HH:MM (24-hour).`);
    return null;
  }
  const [h, m] = time.split(':').map(Number) as [number, number];
  if (h > 23 || m > 59) {
    err(ctx, '12.2', `snooze_until.time: "${time}" out of range (HH 00-23, MM 00-59).`);
    return null;
  }

  let days: Weekday[] | undefined;
  if ('days' in v) {
    const raw = v.days;
    if (!Array.isArray(raw)) {
      err(ctx, '12.2', `snooze_until.days: must be a list of day names.`);
      return null;
    }
    const out: Weekday[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < raw.length; i++) {
      const d = raw[i];
      if (typeof d !== 'string') {
        err(ctx, '12.2', `snooze_until.days[${i}]: must be a string.`);
        continue;
      }
      if (d !== d.toLowerCase()) {
        err(ctx, '12.2', `snooze_until.days[${i}]: "${d}" must be lowercase.`);
        continue;
      }
      if (!WEEKDAY_VALUES.has(d as Weekday)) {
        err(ctx, '12.2', `snooze_until.days[${i}]: "${d}" is not a valid weekday.`);
        continue;
      }
      if (seen.has(d)) {
        err(ctx, '12.2', `snooze_until.days[${i}]: "${d}" appears more than once.`);
        continue;
      }
      seen.add(d);
      out.push(d as Weekday);
    }
    if (out.length === 0) {
      err(ctx, '12.2', `snooze_until.days: list is empty or has no valid entries.`);
      return null;
    }
    days = out;
  }
  return days ? { time, days } : { time };
}

function parseActions(ctx: Ctx, raw: unknown, continueFlag: boolean): Actions | null {
  if (!Array.isArray(raw)) {
    err(ctx, '12.2', `actions: must be a list.`);
    return null;
  }
  if (raw.length === 0) {
    err(ctx, '12.2', `actions: list must not be empty.`);
    return null;
  }

  const out: Actions = {};
  const seenKeys = new Map<string, number>();
  const terminalSeen: string[] = [];
  const labels: string[] = [];
  const forwards: string[] = [];

  for (let i = 0; i < raw.length; i++) {
    const actx = sub(ctx, `actions[${i}]`);
    const entry = raw[i];
    if (!isPlainObject(entry)) {
      err(actx, '12.2', `each action must be a single-key mapping.`);
      continue;
    }
    const keys = Object.keys(entry);
    if (keys.length !== 1) {
      err(actx, '12.2', `each action must have exactly one key (got ${keys.length}: ${keys.join(', ')}).`);
      continue;
    }
    const key = keys[0]!;
    const val = entry[key];

    if (!ACTION_KEYS.has(key)) {
      err(actx, '12.2', `unknown action "${key}".`);
      continue;
    }

    seenKeys.set(key, (seenKeys.get(key) ?? 0) + 1);

    if (TERMINAL_ACTIONS.has(key)) {
      if (val !== true) {
        err(actx, '12.2', `${key}: argumentless action; value must be 'true'.`);
        continue;
      }
      terminalSeen.push(key);
      (out as Record<string, unknown>)[key] = true;
      continue;
    }

    switch (key) {
      case 'mark_read':
      case 'pin':
      case 'notify':
        if (val !== true) {
          err(actx, '12.2', `${key}: argumentless action; value must be 'true' (omit the action to not apply it).`);
          break;
        }
        (out as Record<string, unknown>)[key] = true;
        break;
      case 'add_label': {
        const p = validateLabelPath(actx, val, 'add_label');
        if (p !== null) {
          if (labels.includes(p)) {
            err(actx, '12.2', `add_label: duplicate label "${p}" (already applied earlier in this rule).`);
          } else {
            labels.push(p);
          }
        }
        break;
      }
      case 'send_copy_to': {
        if (typeof val !== 'string' || val === '') {
          err(actx, '12.2', `send_copy_to: value must be a non-empty email address string.`);
          break;
        }
        if (forwards.includes(val)) {
          err(actx, '12.2', `send_copy_to: duplicate address "${val}" (already forwarded earlier in this rule).`);
        } else {
          forwards.push(val);
        }
        break;
      }
      case 'snooze_until': {
        const sched = parseSnooze(actx, val);
        if (sched) out.snooze_until = sched;
        break;
      }
    }
  }

  // Repeatable-only exceptions: add_label and send_copy_to.
  for (const [k, count] of seenKeys) {
    if (count <= 1) continue;
    if (k === 'add_label' || k === 'send_copy_to') continue;
    err(ctx, '12.2', `action "${k}" appears ${count} times; only add_label and send_copy_to may repeat.`);
  }

  // At most one terminal action.
  if (terminalSeen.length > 1) {
    err(ctx, '12.2', `multiple terminal actions present (${terminalSeen.join(', ')}) — at most one of archive, delete_to_trash, send_to_spam per rule.`);
  }

  // continue: true + terminal — §6.
  if (continueFlag && terminalSeen.length > 0) {
    err(ctx, '12.2', `continue: true is incompatible with terminal action(s) (${terminalSeen.join(', ')}). Set continue: false or remove the terminal action.`);
  }

  if (labels.length > 0) out.add_label = labels;
  if (forwards.length > 0) out.send_copy_to = forwards;
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Rule (§6)

const RULE_KEYS = new Set(['name', 'enabled', 'continue', 'when', 'actions']);

function parseRule(fileCtx: Ctx, raw: unknown, index: number): Rule | null {
  const rctx = sub(fileCtx, `rules[${index}]`);
  if (!isPlainObject(raw)) {
    err(rctx, '12.2', `rule must be a mapping.`);
    return null;
  }

  for (const k of Object.keys(raw)) {
    if (!RULE_KEYS.has(k)) {
      err(rctx, '12.2', `unknown key "${k}" (rule fields: name, enabled, continue, when, actions).`);
    }
  }

  // name
  const nameRaw = raw.name;
  if (typeof nameRaw !== 'string' || nameRaw === '') {
    err(rctx, '12.2', `rule missing required non-empty string 'name'.`);
    return null;
  }
  if (nameRaw.includes('#')) {
    err(rctx, '12.2', `rule name "${nameRaw}" contains the reserved character '#'. Use a different delimiter or remove the '#'.`);
    return null;
  }
  if (NAME_CONTROL_RE.test(nameRaw)) {
    err(rctx, '12.2', `rule name contains control / tab characters, which are not allowed.`);
    return null;
  }

  // enabled
  const enabled = raw.enabled;
  if (typeof enabled !== 'boolean') {
    err(rctx, '12.2', `rule "${nameRaw}" missing required boolean 'enabled'.`);
    return null;
  }

  // continue
  const cont = raw.continue;
  if (typeof cont !== 'boolean') {
    err(rctx, '12.2', `rule "${nameRaw}" missing required boolean 'continue'.`);
    return null;
  }

  // when
  if (!('when' in raw)) {
    err(rctx, '12.2', `rule "${nameRaw}" missing required 'when'.`);
    return null;
  }
  const when = parseWhen(sub(rctx, 'when'), raw.when);

  // actions
  if (!('actions' in raw)) {
    err(rctx, '12.2', `rule "${nameRaw}" missing required 'actions'.`);
    return null;
  }
  const actions = parseActions(sub(rctx, 'actions'), raw.actions, cont);

  if (!when || !actions) return null;
  return {
    name: nameRaw,
    enabled,
    continue: cont,
    when,
    actions,
    sourceFile: fileCtx.file,
    sourceIndex: index,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Rule-file (§6)

export function buildRuleFile(raw: RawFile, errors: ErrorCollector): RuleFile | null {
  const ctx: Ctx = { file: raw.relPath, loc: '', errors };
  const v = raw.value;

  if (!isPlainObject(v)) {
    err(ctx, '12.2', `rule file top level must be a mapping with a 'rules:' key.`);
    return null;
  }
  for (const k of Object.keys(v)) {
    if (k !== 'rules') {
      err(ctx, '12.2', `rule file has unexpected top-level key "${k}" (only 'rules:' is allowed).`);
    }
  }
  if (!('rules' in v)) {
    err(ctx, '12.2', `rule file missing top-level 'rules:' key.`);
    return null;
  }
  const rulesRaw = v.rules;
  if (!Array.isArray(rulesRaw)) {
    err(ctx, '12.2', `'rules:' must be a list.`);
    return null;
  }
  if (rulesRaw.length === 0) {
    err(ctx, '12.2', `'rules:' must contain at least one rule.`);
    return null;
  }

  const rules: Rule[] = [];
  for (let i = 0; i < rulesRaw.length; i++) {
    const r = parseRule(ctx, rulesRaw[i], i);
    if (r) rules.push(r);
  }

  // Name uniqueness within this file (checked globally too, but good to
  // also report per-file for locality).
  // The global check happens after all files load — see `checkGlobalNameUniqueness`.

  return { path: raw.relPath, rules };
}

// ────────────────────────────────────────────────────────────────────────────
// Snippet file (§7)

const SNIPPET_FORBIDDEN = new Set([
  'rules',
  'name',
  'enabled',
  'continue',
  'when',
  'actions',
  'extends',
]);

export function buildSnippetFile(raw: RawFile, errors: ErrorCollector): SnippetFile | null {
  const ctx: Ctx = { file: raw.relPath, loc: '', errors };
  const v = raw.value;

  if (!isPlainObject(v)) {
    err(ctx, '12.3', `snippet file top level must be a mapping with one combinator key (all/any/not).`);
    return null;
  }
  const keys = Object.keys(v);
  if (keys.length === 0) {
    err(ctx, '12.3', `snippet file is empty.`);
    return null;
  }
  if (keys.length > 1) {
    err(ctx, '12.3', `snippet file must have exactly one top-level key (got ${keys.length}: ${keys.join(', ')}).`);
    return null;
  }
  const key = keys[0]!;
  if (key === 'always') {
    err(ctx, '12.3', `\`always\` is not valid in snippets — it is only the bare value of \`when:\` in a rule.`);
    return null;
  }
  if (SNIPPET_FORBIDDEN.has(key)) {
    err(ctx, '12.3', `snippet file must not contain "${key}:" — snippets are bare condition trees. Use a combinator (all/any/not) at the top level.`);
    return null;
  }
  if (!COMBINATOR_KEYS.has(key)) {
    err(ctx, '12.3', `snippet top-level must be one of all/any/not (got "${key}").`);
    return null;
  }

  const cond = parseCondition(ctx, v, { allowExtends: false });
  if (!cond) return null;
  return { path: raw.relPath, root: cond };
}

// ────────────────────────────────────────────────────────────────────────────
// Cross-file global checks (§6.1 name uniqueness)

export function checkGlobalNameUniqueness(
  ruleFiles: readonly RuleFile[],
  errors: ErrorCollector,
): void {
  // Per §6.1: at most one enabled + at most one disabled rule per name.
  const enabledByName = new Map<string, { file: string }[]>();
  const disabledByName = new Map<string, { file: string }[]>();
  for (const f of ruleFiles) {
    for (const r of f.rules) {
      const map = r.enabled ? enabledByName : disabledByName;
      const entries = map.get(r.name) ?? [];
      entries.push({ file: f.path });
      map.set(r.name, entries);
    }
  }
  for (const [name, locs] of enabledByName) {
    if (locs.length > 1) {
      errors.error({
        file: Array.from(new Set(locs.map((l) => l.file))),
        tag: '12.2',
        message: `duplicate enabled rule name "${name}" appears in ${locs.length} places; only one enabled rule may have a given name (§6.1).`,
      });
    }
  }
  for (const [name, locs] of disabledByName) {
    if (locs.length > 1) {
      errors.error({
        file: Array.from(new Set(locs.map((l) => l.file))),
        tag: '12.2',
        message: `duplicate disabled rule name "${name}" appears in ${locs.length} places; only one disabled rule may have a given name (§6.1 caps at one predecessor).`,
      });
    }
  }
}

// Re-export path helpers used by tests / downstream.
export function projectRootPath(cwd: string, relPath: string): string {
  return path.join(cwd, relPath);
}
