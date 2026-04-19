/**
 * Single source of truth for every authorable matcher and action field.
 *
 * Adding or renaming a field happens here; schema ([./yaml.ts](./yaml.ts)),
 * normalization ([../compile/normalize.ts](../compile/normalize.ts)), and
 * emit defaults ([../compile/emit.ts](../compile/emit.ts)) derive from this
 * table. The TS `Matchers` / `Actions` / `EmittedRule` types in
 * [../types.ts](../types.ts) stay hand-written and are held in sync by
 * `tests/field-registry.test.ts`.
 *
 * Action row order mirrors the key order in `EmittedRule` (and therefore the
 * emitted JSON) because `emit.ts` iterates `ACTION_FIELDS` when building the
 * output object.
 *
 * FIELDS is declared `as const` so consumers can derive literal-typed shapes
 * via mapped types (see yaml.ts).
 */

export type FieldKind = 'matcher' | 'action';

/**
 * Value shape of a field. Drives the zod mapping in yaml.ts, the
 * yaml→internal conversion in normalize.ts, and the default value in emit.ts.
 *
 *   matcherValue  `MatcherValue` — string | string[] | {any?, all?}
 *   bool          boolean
 *   string        plain string
 *   stringOrList  string | string[]; normalized to string[] on intake
 *   header        {name, value} | [{name, value}, ...]
 *   searchExpr    recursive `SearchExpr` — shared with declarative modules
 *   snooze        {date: string}
 *   raw           opaque Fastmail search fragment (string)
 */
export type FieldShape =
  | 'matcherValue'
  | 'bool'
  | 'string'
  | 'stringOrList'
  | 'header'
  | 'searchExpr'
  | 'snooze'
  | 'raw';

export interface FieldSpec {
  /** snake_case YAML key. */
  yaml: string;
  /** camelCase key on `PartialRule.matchers` / `.actions` / `EmittedRule`. */
  internal: string;
  kind: FieldKind;
  shape: FieldShape;
  /** When true, explicit `null` is a valid value distinct from omission. */
  nullable?: boolean;
}

export const FIELDS = [
  { yaml: 'from', internal: 'from', kind: 'matcher', shape: 'matcherValue' },
  { yaml: 'to', internal: 'to', kind: 'matcher', shape: 'matcherValue' },
  { yaml: 'subject', internal: 'subject', kind: 'matcher', shape: 'matcherValue' },
  { yaml: 'body', internal: 'body', kind: 'matcher', shape: 'matcherValue' },
  { yaml: 'header', internal: 'header', kind: 'matcher', shape: 'header' },
  { yaml: 'match', internal: 'match', kind: 'matcher', shape: 'searchExpr' },
  { yaml: 'list', internal: 'list', kind: 'matcher', shape: 'matcherValue' },
  { yaml: 'with', internal: 'with', kind: 'matcher', shape: 'matcherValue' },
  { yaml: 'text', internal: 'text', kind: 'matcher', shape: 'matcherValue' },
  { yaml: 'domain', internal: 'domain', kind: 'matcher', shape: 'matcherValue' },
  { yaml: 'search_raw', internal: 'searchRaw', kind: 'matcher', shape: 'raw' },

  { yaml: 'mark_read', internal: 'markRead', kind: 'action', shape: 'bool' },
  { yaml: 'mark_flagged', internal: 'markFlagged', kind: 'action', shape: 'bool' },
  { yaml: 'show_notification', internal: 'showNotification', kind: 'action', shape: 'bool' },
  { yaml: 'redirect_to', internal: 'redirectTo', kind: 'action', shape: 'stringOrList', nullable: true },
  { yaml: 'file_in', internal: 'fileIn', kind: 'action', shape: 'string', nullable: true },
  { yaml: 'skip_inbox', internal: 'skipInbox', kind: 'action', shape: 'bool' },
  { yaml: 'snooze_until', internal: 'snoozeUntil', kind: 'action', shape: 'snooze', nullable: true },
  { yaml: 'discard', internal: 'discard', kind: 'action', shape: 'bool' },
  { yaml: 'mark_spam', internal: 'markSpam', kind: 'action', shape: 'bool' },
  { yaml: 'stop', internal: 'stop', kind: 'action', shape: 'bool' },
] as const satisfies readonly FieldSpec[];

export type AllFields = typeof FIELDS[number];
export type MatcherField = Extract<AllFields, { kind: 'matcher' }>;
export type ActionField = Extract<AllFields, { kind: 'action' }>;

export const MATCHER_FIELDS: readonly MatcherField[] = FIELDS.filter(
  (f): f is MatcherField => f.kind === 'matcher',
);
export const ACTION_FIELDS: readonly ActionField[] = FIELDS.filter(
  (f): f is ActionField => f.kind === 'action',
);
